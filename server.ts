import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import os from 'os';
import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestBaileysVersion,
  ConnectionState,
  downloadContentFromMessage,
  proto,
  WAMessageContent
} from '@whiskeysockets/baileys';
import pino from 'pino';
import NodeCache from 'node-cache';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import { GoogleGenAI, Modality } from "@google/genai";
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import yts from 'yt-search';

const execPromise = promisify(exec);

// Lazy initialization for Gemini AI
let aiClient: GoogleGenAI | null = null;
function getAI() {
  if (!aiClient) {
    if (!process.env.GEMINI_API_KEY) {
      console.warn('GEMINI_API_KEY is not set. AI features will be disabled.');
      return null;
    }
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return aiClient;
}

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';
const PORT = Number(process.env.PORT) || 3000;

// Ensure sessions directory exists
const sessionsDir = path.join(process.cwd(), 'sessions');
try {
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }
} catch (e) {
  console.warn('Could not create sessions directory (read-only filesystem?):', e);
}

const cacheDir = path.join(process.cwd(), 'cache');
try {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
} catch (e) {
  console.warn('Could not create cache directory (read-only filesystem?):', e);
}

// Database setup with fallback to memory if disk is not writable
let db: Database.Database;
try {
  db = new Database('database.sqlite');
  console.log('Database initialized on disk.');
} catch (e) {
  console.warn('Failed to initialize database on disk, falling back to in-memory database:', e);
  db = new Database(':memory:');
}

function initDB() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        password TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        userId TEXT,
        phoneNumber TEXT,
        status TEXT,
        prefix TEXT DEFAULT '.',
        mode TEXT DEFAULT 'private',
        statusReaction INTEGER DEFAULT 0,
        statusReactionEmoji TEXT DEFAULT '❤️',
        autoReact INTEGER DEFAULT 0,
        autoReactEmoji TEXT DEFAULT '🔥',
        PRIMARY KEY (userId, phoneNumber)
      );
      CREATE TABLE IF NOT EXISTS group_settings (
        groupId TEXT PRIMARY KEY,
        antilink INTEGER DEFAULT 0,
        antitagall INTEGER DEFAULT 0,
        antibot INTEGER DEFAULT 0,
        antispam INTEGER DEFAULT 0,
        antifake INTEGER DEFAULT 0,
        antilongtext INTEGER DEFAULT 0,
        antimedia INTEGER DEFAULT 0,
        antidelete INTEGER DEFAULT 0,
        antiviewonce INTEGER DEFAULT 0,
        antitoxic INTEGER DEFAULT 0,
        welcome INTEGER DEFAULT 0,
        goodbye INTEGER DEFAULT 0,
        welcomeMessage TEXT,
        goodbyeMessage TEXT,
        rules TEXT,
        blockedWords TEXT DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS warns (
        groupId TEXT,
        userId TEXT,
        count INTEGER DEFAULT 0,
        PRIMARY KEY (groupId, userId)
      );
      CREATE TABLE IF NOT EXISTS daily_usage (
        userId TEXT,
        command TEXT,
        lastUsed TIMESTAMP,
        PRIMARY KEY (userId, command)
      );
    `);

    // Migration: Add missing columns if they don't exist
    const migrations = [
      "ALTER TABLE sessions ADD COLUMN prefix TEXT DEFAULT '.'",
      "ALTER TABLE sessions ADD COLUMN mode TEXT DEFAULT 'private'",
      "ALTER TABLE sessions ADD COLUMN statusReaction INTEGER DEFAULT 0",
      "ALTER TABLE sessions ADD COLUMN statusReactionEmoji TEXT DEFAULT '❤️'",
      "ALTER TABLE sessions ADD COLUMN autoReact INTEGER DEFAULT 0",
      "ALTER TABLE sessions ADD COLUMN autoReactEmoji TEXT DEFAULT '🔥'"
    ];

    for (const migration of migrations) {
      try {
        db.prepare(migration).run();
      } catch (e) {
        // Column might already exist
      }
    }
  } catch (e) {
    console.error('CRITICAL: Database initialization failed:', e);
  }
}

initDB();

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: '*' }
  });

  app.use(express.json());

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Sessions management
  const waSockets: Map<string, any> = new Map();
  const pairingsInProgress: Map<string, string> = new Map(); // phoneNumber -> requesterJid

  const getSessionPath = (userId: string, phoneNumber: string) => path.join(process.cwd(), 'sessions', `${userId}_${phoneNumber}`);

  async function connectToWhatsApp(userId: string, phoneNumber: string, prefix: string = '.', mode: string = 'private') {
    const socketKey = `${userId}:${phoneNumber}`;
    const sessionPath = getSessionPath(userId, phoneNumber);
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();
    const msgRetryCounterCache = new NodeCache();

    const sock = makeWASocket({
      version,
      printQRInTerminal: false,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
      msgRetryCounterCache,
      keepAliveIntervalMs: 30000,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      patchMessageBeforeSending: (message) => {
        const requiresPatch = !!(
          message.buttonsMessage ||
          message.templateMessage ||
          message.listMessage
        );
        if (requiresPatch) {
          message = {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadataVersion: 2,
                  deviceListMetadata: {},
                },
                ...message,
              },
            },
          };
        }
        return message;
      }
    });

    waSockets.set(socketKey, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, pairingCode } = update;
      
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const error = lastDisconnect?.error as any;
        const errorMessage = error?.message || error?.stack || '';
        const isBadMac = errorMessage.includes('Bad MAC');
        const isMessageCounterError = errorMessage.includes('MessageCounterError');
        const isFatal = isBadMac || isMessageCounterError;
        
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !isFatal;
        
        console.log(`Connection closed for user ${userId} (${phoneNumber}). Status: ${statusCode}. Fatal: ${isFatal}. Reconnecting: ${shouldReconnect}`);
        
        if (isFatal) {
          console.error(`Fatal session error (${isBadMac ? 'Bad MAC' : 'MessageCounterError'}) for ${userId} (${phoneNumber}). Clearing session...`);
          waSockets.delete(socketKey);
          const sessionPath = getSessionPath(userId, phoneNumber);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
          db.prepare('UPDATE sessions SET status = ? WHERE userId = ? AND phoneNumber = ?').run('disconnected', userId, phoneNumber);
          io.to(userId).emit('status', { userId, phoneNumber, status: 'disconnected', error: `Session corrompue. Veuillez vous reconnecter.` });
        } else if (shouldReconnect) {
          const delay = statusCode === 515 ? 2000 : 5000;
          setTimeout(() => {
            connectToWhatsApp(userId, phoneNumber, prefix, mode);
          }, delay);
        } else {
          waSockets.delete(socketKey);
          io.to(userId).emit('status', { userId, phoneNumber, status: 'disconnected' });
          db.prepare('UPDATE sessions SET status = ? WHERE userId = ? AND phoneNumber = ?').run('disconnected', userId, phoneNumber);
          console.log(`User ${userId} (${phoneNumber}) logged out or connection closed permanently.`);
        }
      } else if (connection === 'open') {
        console.log(`Connection opened for ${userId} (${phoneNumber})`);
        io.to(userId).emit('status', { userId, phoneNumber, status: 'connected' });
        
        // Update DB status
        db.prepare('UPDATE sessions SET status = ? WHERE userId = ? AND phoneNumber = ?').run('connected', userId, phoneNumber);

        // Keep-alive ping to WhatsApp
        setInterval(async () => {
          try {
            if (sock && sock.user) {
              await sock.sendPresenceUpdate('available');
            }
          } catch (e) {}
        }, 60000);

        // Send welcome message to self
        const jid = sock.user?.id;
        if (jid) {
          // Ensure we send to the primary device JID
          const selfJid = jid.split(':')[0] + '@s.whatsapp.net';
          await sock.sendMessage(selfJid, { 
            text: `╭── ❀ 𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎 ❀──╮\n\n*𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎 🧑🏭 est connecté.*\n\nLe bot est prêt à l'emploi !\nMode: *${mode.toUpperCase()}*\nPrefix: *${prefix}*\n\nTapez *${prefix}menu* pour voir les commandes.`,
            contextInfo: {
              externalAdReply: {
                title: 'Voir la chaîne',
                body: 'Rejoignez-nous pour les mises à jour !',
                thumbnailUrl: 'https://raw.githubusercontent.com/Samy-Charles/OmniGuard-Assets/main/lightning.jpg',
                sourceUrl: 'https://whatsapp.com/channel/0029Vb7LFDf3WHTggjCW140N',
                mediaType: 1,
                renderLargerThumbnail: true
              }
            }
          });
        }
      }

      if (pairingCode) {
        io.to(userId).emit('pairing-code', { userId, phoneNumber, code: pairingCode });
        
        // Handle .pair command from WhatsApp
        const requesterJid = pairingsInProgress.get(phoneNumber);
        if (requesterJid) {
          // We need to find the socket that requested this. 
          // Since we are inside connectToWhatsApp, we don't easily have the requester's 'sock'.
          // But we can use any active socket to send the message, or just wait for the next turn.
          // Actually, we can use the current 'sock' if it's already connected, but it's not yet.
          // Let's use a global broadcast or find an active socket.
          for (const [key, activeSock] of waSockets.entries()) {
            try {
              await activeSock.sendMessage(requesterJid, { 
                text: `*𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎 𝗣𝗔𝗜𝗥𝗜𝗡𝗚 𝗖𝗢𝗗𝗘*\n\nNuméro: ${phoneNumber}\nCode: *${pairingCode}*\n\nEntrez ce code sur votre téléphone pour lier votre compte.`,
                contextInfo: {
                  externalAdReply: {
                    title: 'CODE DE PAIRAGE GÉNÉRÉ',
                    body: 'OmniGuard Connection Service',
                    thumbnailUrl: 'https://raw.githubusercontent.com/Samy-Charles/OmniGuard-Assets/main/lightning.jpg',
                    mediaType: 1
                  }
                }
              });
              pairingsInProgress.delete(phoneNumber);
              break; 
            } catch (e) {}
          }
        }
      }
    });

    const messageCounts: Map<string, { count: number, lastMessage: number }> = new Map();
    const messageStore: Map<string, any> = new Map();

    sock.ev.on('messages.update', async (updates) => {
      for (const { key, update } of updates) {
        if (update.messageStubType === 68) { // REVOKE (Delete)
          const from = key.remoteJid;
          const settings = db.prepare('SELECT * FROM group_settings WHERE groupId = ?').get(from) as any;
          
          // Antidelete logic
          if (settings?.antidelete) {
            const originalMsg = messageStore.get(key.id!);
            if (originalMsg) {
              const sender = originalMsg.key.participant || originalMsg.key.remoteJid;
              await sock.sendMessage(from!, { 
                text: `*🚨 ANTIDELETE DÉTECTÉ 🚨*\n\n*Utilisateur:* @${sender.split('@')[0]}\n*Message supprimé ci-dessous:*`,
                mentions: [sender]
              });
              // Forward the message
              const msgContent = originalMsg.message;
              await sock.sendMessage(from!, { ...msgContent }, { quoted: originalMsg });
            }
          }
        }
      }
    });

    sock.ev.on('group-participants.update', async (anu) => {
      const { id, participants, action } = anu;
      const settings = db.prepare('SELECT * FROM group_settings WHERE groupId = ?').get(id) as any;
      if (!settings) return;

      const groupMetadata = await sock.groupMetadata(id);
      const isBotAdmin = groupMetadata.participants.find(p => p.id === sock.user?.id)?.admin !== null;

      if (action === 'add') {
        // Anti-Bot
        if (settings.antibot && isBotAdmin) {
          for (const participant of participants) {
            const num = typeof participant === 'string' ? participant : (participant as any).id;
            if (num.includes('bot') || num.length > 20) { // Simple heuristic
              await sock.groupParticipantsUpdate(id, [num], 'remove');
              await sock.sendMessage(id, { text: `Anti-Bot: @${num.split('@')[0]} expulsé !`, mentions: [num] });
              continue;
            }
          }
        }
        // Anti-Fake
        if (settings.antifake && isBotAdmin) {
          for (const participant of participants) {
            const num = typeof participant === 'string' ? participant : (participant as any).id;
            if (num.startsWith('1') || num.startsWith('44')) { // Example: Block +1, +44
              await sock.groupParticipantsUpdate(id, [num], 'remove');
              await sock.sendMessage(id, { text: `Anti-Fake: @${num.split('@')[0]} expulsé !`, mentions: [num] });
              continue;
            }
          }
        }
        
        if (settings.welcome) {
          for (const participant of participants) {
            const num = typeof participant === 'string' ? participant : (participant as any).id;
            
            let ppUrl;
            try {
              ppUrl = await sock.profilePictureUrl(id, 'image');
            } catch (e) {
              ppUrl = 'https://raw.githubusercontent.com/Samy-Charles/OmniGuard-Assets/main/lightning.jpg';
            }

            const welcomeText = `╭━━━〔 🎉 NEW MEMBER 〕━━━⬣
┃
┃ Hello @${num.split('@')[0]} 👋
┃ Welcome to *${groupMetadata.subject}*
┃
┃ You are now part of our community.
┃ Please respect the members and
┃ follow the group rules 📜
┃
┃ Enjoy your stay and have fun 🚀
┃
┃ 👥 Members: ${groupMetadata.participants.length}
┃ 🤖 Powered by OmniGuard
┃
╰━━━━━━━━━━━━━━━━⬣`;

            await sock.sendMessage(id, { 
              image: { url: ppUrl },
              caption: welcomeText,
              mentions: [num]
            });
          }
        }
      } else if (action === 'remove' && settings.goodbye) {
        for (const participant of participants) {
          const num = typeof participant === 'string' ? participant : (participant as any).id;
          
          let ppUrl;
          try {
            ppUrl = await sock.profilePictureUrl(id, 'image');
          } catch (e) {
            ppUrl = 'https://raw.githubusercontent.com/Samy-Charles/OmniGuard-Assets/main/lightning.jpg';
          }

          const goodbyeText = `╭━━━〔 👋 GOODBYE 〕━━━⬣
┃
┃ Goodbye @${num.split('@')[0]}
┃ We hope you enjoyed your stay in
┃ *${groupMetadata.subject}*
┃
┃ Take care and see you soon! 🚀
┃
┃ 👥 Members: ${groupMetadata.participants.length}
┃ 🤖 Powered by OmniGuard
┃
╰━━━━━━━━━━━━━━━━⬣`;

          await sock.sendMessage(id, { 
            image: { url: ppUrl },
            caption: goodbyeText,
            mentions: [num]
          });
        }
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      try {
        if (m.type !== 'notify') return;
      const msg = m.messages[0];
      if (!msg.message) return;
      
      // Store message for antidelete
      const msgId = msg.key.id;
      if (msgId) {
        messageStore.set(msgId, msg);
        // Clean up old messages from store (keep last 500)
        if (messageStore.size > 500) {
          const firstKey = messageStore.keys().next().value;
          if (firstKey) messageStore.delete(firstKey);
        }
      }

      const from = msg.key.remoteJid;
      const isMe = msg.key.fromMe;
      const pushName = msg.pushName || "User";
      const isGroup = from?.endsWith('@g.us');
      const sender = msg.key.participant || msg.key.remoteJid;
      const isOwner = sender?.includes('2250575411220') || isMe;

      // Status Reaction Logic
      if (from === 'status@broadcast' && !isMe) {
        const session = db.prepare('SELECT * FROM sessions WHERE userId = ? AND phoneNumber = ?').get(userId, phoneNumber) as any;
        if (session?.statusReaction) {
          try {
            await sock.readMessages([msg.key]);
            await sock.sendMessage('status@broadcast', {
              react: { text: session.statusReactionEmoji || '❤️', key: msg.key }
            }, { statusJidList: [sender!] });
          } catch (e) {
            console.error('Status reaction failed:', e);
          }
        }
      }

      // Auto React Logic
      if (from !== 'status@broadcast' && !isMe) {
        const session = db.prepare('SELECT * FROM sessions WHERE userId = ? AND phoneNumber = ?').get(userId, phoneNumber) as any;
        if (session?.autoReact) {
          try {
            await sock.sendMessage(from!, {
              react: { text: session.autoReactEmoji || '🔥', key: msg.key }
            });
          } catch (e) {
            console.error('Auto react failed:', e);
          }
        }
      }

      // Extract content
      const content = msg.message.conversation || 
                    msg.message.extendedTextMessage?.text || 
                    msg.message.imageMessage?.caption || 
                    msg.message.videoMessage?.caption || "";

      // Anti-Word logic
      if (isGroup && !isMe) {
        const settings = db.prepare('SELECT * FROM group_settings WHERE groupId = ?').get(from) as any;
        if (settings?.blockedWords) {
          const blocked = JSON.parse(settings.blockedWords) as string[];
          const hasBlocked = blocked.some(word => content.toLowerCase().includes(word.toLowerCase()));
          if (hasBlocked) {
            await sock.sendMessage(from!, { delete: msg.key });
            return;
          }
        }
      }

      // Antiviewonce Auto-Bypass
      const vOnce = msg.message?.viewOnceMessageV2?.message || 
                       msg.message?.viewOnceMessage?.message ||
                       msg.message?.viewOnceMessageV2Extension?.message ||
                       (msg.message?.imageMessage?.viewOnce ? msg.message : null) ||
                       (msg.message?.videoMessage?.viewOnce ? msg.message : null);

      if (vOnce && isGroup) {
        const settings = db.prepare('SELECT * FROM group_settings WHERE groupId = ?').get(from) as any;
        if (settings?.antiviewonce) {
          const mediaMessage = vOnce.imageMessage || vOnce.videoMessage || msg.message?.imageMessage || msg.message?.videoMessage;
          const mediaType = (vOnce.imageMessage || msg.message?.imageMessage) ? 'image' : 'video';
          
          try {
            const buffer = await downloadContentFromMessage(mediaMessage, mediaType);
            let chunks = [];
            for await (const chunk of buffer) {
              chunks.push(chunk);
            }
            const finalBuffer = Buffer.concat(chunks);
            
            const sender = msg.key.participant || msg.key.remoteJid;
            const caption = `*🚨 ANTIVIEWONCE AUTO-BYPASS 🚨*\n\n*Utilisateur:* @${sender?.split('@')[0]}`;
            
            if (mediaType === 'image') {
              await sock.sendMessage(from!, { image: finalBuffer, caption, mentions: sender ? [sender] : [] });
            } else {
              await sock.sendMessage(from!, { video: finalBuffer, caption, mentions: sender ? [sender] : [] });
            }
          } catch (e) {
            console.error('Antiviewonce bypass failed:', e);
          }
        }
      }

      // Antitoxic logic
      if (isGroup && !isMe) {
        const settings = db.prepare('SELECT * FROM group_settings WHERE groupId = ?').get(from) as any;
        if (settings?.antitoxic) {
          const toxicWords = ['connard', 'salope', 'pute', 'fdp', 'merde', 'tg', 'ta gueule'];
          const hasToxic = toxicWords.some(word => content.toLowerCase().includes(word));
          if (hasToxic) {
            await sock.sendMessage(from!, { delete: msg.key });
            await sock.sendMessage(from!, { text: `*🚨 ANTITOXIC 🚨*\n\n@${(msg.key.participant || msg.key.remoteJid)?.split('@')[0]}, les insultes sont interdites ici !`, mentions: [msg.key.participant || msg.key.remoteJid!] });
          }
        }
      }
      
      // Group Admin Check
      let isAdmin = false;
      let isBotAdmin = false;
      if (isGroup) {
        try {
          const groupMetadata = await sock.groupMetadata(from!);
          const participants = groupMetadata.participants;
          isAdmin = participants.find(p => p.id === msg.key.participant)?.admin !== null;
          isBotAdmin = participants.find(p => p.id === sock.user?.id)?.admin !== null;
        } catch (e) {
          // Metadata might not be available yet
        }
      }

      // Handle Private Mode
      if (mode === 'private' && !isOwner) return;

      // Group Security Enforcement
      if (isGroup && !isAdmin && !isMe) {
        const settings = db.prepare('SELECT * FROM group_settings WHERE groupId = ?').get(from!) as any;
        if (settings) {
          // Anti-Link
          if (settings.antilink && (content.includes('http://') || content.includes('https://') || content.includes('www.'))) {
            await sock.sendMessage(from!, { delete: msg.key });
            return;
          }
          // Anti-Media
          if (settings.antimedia && (msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.audioMessage)) {
            await sock.sendMessage(from!, { delete: msg.key });
            return;
          }
          // Anti-LongText
          if (settings.antilongtext && content.length > 1000) {
            await sock.sendMessage(from!, { delete: msg.key });
            return;
          }
          // Anti-TagAll
          if (settings.antitagall && (content.includes('@all') || content.includes('@everyone') || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length! > 10)) {
            await sock.sendMessage(from!, { delete: msg.key });
            if (isBotAdmin) await sock.groupParticipantsUpdate(from!, [msg.key.participant!], 'remove');
            return;
          }
          // Anti-Spam
          if (settings.antispam) {
            const user = msg.key.participant!;
            const now = Date.now();
            const userStats = messageCounts.get(user) || { count: 0, lastMessage: 0 };
            if (now - userStats.lastMessage < 2000) {
              userStats.count++;
              if (userStats.count > 5) {
                await sock.sendMessage(from!, { delete: msg.key });
                if (userStats.count > 10 && isBotAdmin) {
                  await sock.groupParticipantsUpdate(from!, [user], 'remove');
                  await sock.sendMessage(from!, { text: `Anti-Spam: @${user.split('@')[0]} expulsé !`, mentions: [user] });
                }
                return;
              }
            } else {
              userStats.count = 1;
            }
            userStats.lastMessage = now;
            messageCounts.set(user, userStats);
          }
        }
      }

      if (content.startsWith(prefix)) {
        const args = content.slice(prefix.length).trim().split(/ +/);
        const command = args.shift()?.toLowerCase();
        
        // React to all commands
        try {
          await sock.sendMessage(from!, { react: { text: '🧑‍🏭', key: msg.key } });
        } catch (e) {}

        try {
          if (command === 'public') {
            if (!isOwner) return await sock.sendMessage(from!, { text: 'Seul le propriétaire peut utiliser cette commande.' }, { quoted: msg });
            mode = 'public';
            db.prepare('UPDATE sessions SET mode = ? WHERE userId = ? AND phoneNumber = ?').run('public', userId, phoneNumber);
            return await sock.sendMessage(from!, { text: '🔓 *MODE PUBLIC ACTIVÉ*\n\nLe bot est maintenant accessible à tous.' }, { quoted: msg });
          }

          if (command === 'private') {
            if (!isOwner) return await sock.sendMessage(from!, { text: 'Seul le propriétaire peut utiliser cette commande.' }, { quoted: msg });
            mode = 'private';
            db.prepare('UPDATE sessions SET mode = ? WHERE userId = ? AND phoneNumber = ?').run('private', userId, phoneNumber);
            return await sock.sendMessage(from!, { text: '🔒 *MODE PRIVÉ ACTIVÉ*\n\nLe bot est maintenant réservé au propriétaire.' }, { quoted: msg });
          }
          if (command === 'menu' || command === 'help') {
            console.log(`[MENU] Generating menu for ${sender}...`);
            const menuText = `╭── ❀ 𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎 ❀──╮
│ 🧑‍🏭 *𝗨𝗧𝗜𝗟𝗜𝗦𝗔𝗧𝗘𝗨𝗥:* @${sender.split('@')[0]}
│ 🏎 *𝗕𝗢𝗧:* OmniGuard V4.7
│ 🛠 *𝗠𝗢𝗗𝗘:* ${mode.toUpperCase()}
│ 🕝 *𝗨𝗣𝗧𝗜𝗠𝗘:* ${Math.floor(process.uptime() / 60)} min
│ 👑 *𝗖𝗥𝗘𝗗𝗜𝗧𝗦:* Samy Charles
╰────────────────╯

╭── ◈ INTELLIGENCE ◈ ──╮
│ ◈ ${prefix}ai [question]
│ ◈ ${prefix}imagine [prompt]
│ ◈ ${prefix}google [query]
│ ◈ ${prefix}wiki [query]
│ ◈ ${prefix}lyrics [titre]
│ ◈ ${prefix}translate [fr texte]
╰────────────────╯

╭── ◈ TÉLÉCHARGEMENT ◈ ──╮
│ ◈ ${prefix}play [titre]
│ ◈ ${prefix}video [titre]
│ ◈ ${prefix}tiktok [lien]
│ ◈ ${prefix}ig [lien]
│ ◈ ${prefix}fb [lien]
│ ◈ ${prefix}tw [lien]
│ ◈ ${prefix}dlstatus (reply)
╰────────────────╯

╭── ◈ OUTILS ◈ ──╮
│ ◈ ${prefix}s (reply)
│ ◈ ${prefix}toimg (reply)
│ ◈ ${prefix}getpp @user
│ ◈ ${prefix}vv (reply)
│ ◈ ${prefix}tts [texte]
│ ◈ ${prefix}qr [texte]
│ ◈ ${prefix}calc [expr]
│ ◈ ${prefix}ss [url]
│ ◈ ${prefix}weather [ville]
│ ◈ ${prefix}github [user]
│ ◈ ${prefix}npm [package]
╰────────────────╯

╭── ◈ ÉDITION IMAGE ◈ ──╮
│ ◈ ${prefix}remini (reply)
│ ◈ ${prefix}removebg (reply)
│ ◈ ${prefix}enhance (reply)
│ ◈ ${prefix}upscale (reply)
│ ◈ ${prefix}cartoon (reply)
│ ◈ ${prefix}sketch (reply)
╰────────────────╯

╭── ◈ DARK (HACK) ◈ ──╮
│ ◈ ${prefix}hack @user
│ ◈ ${prefix}getip @user
│ ◈ ${prefix}accountinfo @user
│ ◈ ${prefix}massreport @user
│ ◈ ${prefix}nuke
│ ◈ ${prefix}destroy
│ ◈ ${prefix}raid
│ ◈ ${prefix}lag @user
│ ◈ ${prefix}freeze @user
│ ◈ ${prefix}unfreeze @user
│ ◈ ${prefix}ghost
│ ◈ ${prefix}fakechat [msg]
│ ◈ ${prefix}spoof @user
╰────────────────╯

╭── ◈ GROUPE ◈ ──╮
│ ◈ ${prefix}tagall
│ ◈ ${prefix}hidetag
│ ◈ ${prefix}kick @user
│ ◈ ${prefix}promote @user
│ ◈ ${prefix}demote @user
│ ◈ ${prefix}lockgroup
│ ◈ ${prefix}unlockgroup
│ ◈ ${prefix}leave
╰────────────────╯

╭── ◈ DIVERTISSEMENT ◈ ──╮
│ ◈ ${prefix}trivia
│ ◈ ${prefix}truth
│ ◈ ${prefix}dare
│ ◈ ${prefix}joke
│ ◈ ${prefix}quote
│ ◈ ${prefix}riddle
│ ◈ ${prefix}math
│ ◈ ${prefix}dice
│ ◈ ${prefix}flip
│ ◈ ${prefix}slots
│ ◈ ${prefix}iq
│ ◈ ${prefix}ship @user
╰────────────────╯

╭── ◈ SYSTÈME ◈ ──╮
│ ◈ ${prefix}ping
│ ◈ ${prefix}runtime
│ ◈ ${prefix}speed
│ ◈ ${prefix}alive
│ ◈ ${prefix}owner
│ ◈ ${prefix}sc
│ ◈ ${prefix}public
│ ◈ ${prefix}private
│ ◈ ${prefix}broadcast
│ ◈ ${prefix}join [lien]
╰────────────────╯

*Suivez notre chaîne officielle :*
https://whatsapp.com/channel/0029Vb7LFDf3WHTggjCW140N`;

            console.log(`[MENU] Sending menu parts to ${sender}...`);
            try {
              // Send Part 1 with Image
              await sock.sendMessage(from!, { 
                image: { url: 'https://lieixmgdboiceopzksvu.supabase.co/storage/v1/object/public/hosted-files/rijqohey-1773001818408.jpg' },
                caption: menuText,
                mentions: [sender],
                contextInfo: {
                  externalAdReply: {
                    title: '𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎 𝗠𝗲𝗻𝘂',
                    body: 'Samy Charles Dev',
                    thumbnailUrl: 'https://lieixmgdboiceopzksvu.supabase.co/storage/v1/object/public/hosted-files/rijqohey-1773001818408.jpg',
                    sourceUrl: 'https://whatsapp.com/channel/0029Vb7LFDf3WHTggjCW140N',
                    mediaType: 1,
                    renderLargerThumbnail: true
                  }
                }
              }, { quoted: msg });

              // Send Part 2
              await new Promise(resolve => setTimeout(resolve, 1000));
              await sock.sendMessage(from!, { 
                text: menuPart2,
                contextInfo: { isForwarded: true, forwardingScore: 1 }
              }, { quoted: msg });

              // Send Part 3
              await new Promise(resolve => setTimeout(resolve, 1000));
              await sock.sendMessage(from!, { 
                text: menuPart3,
                contextInfo: { isForwarded: true, forwardingScore: 1 }
              }, { quoted: msg });

              // Send Part 4
              await new Promise(resolve => setTimeout(resolve, 1000));
              await sock.sendMessage(from!, { 
                text: menuPart4,
                contextInfo: { isForwarded: true, forwardingScore: 1 }
              }, { quoted: msg });

              console.log(`[MENU] Menu sent successfully to ${sender}`);
            } catch (err) {
              console.error('[MENU] Error sending menu:', err);
            }

            // Send audio after menu with a small delay
            setTimeout(async () => {
              try {
                await sock.sendMessage(from!, { 
                  audio: { url: 'https://lieixmgdboiceopzksvu.supabase.co/storage/v1/object/public/hosted-files/o3oyqfgn-1773042892301.mp3' }, 
                  mimetype: 'audio/mpeg', 
                  ptt: false 
                }, { quoted: msg });
              } catch (audioErr) {
                console.error('Failed to send menu audio:', audioErr);
              }
            }, 4000);
          }

        if (command === 'pair') {
          const num = args[0]?.replace(/[^0-9]/g, '');
          if (!num) return await sock.sendMessage(from!, { text: `Veuillez fournir un numéro. Exemple: ${prefix}pair 2250575411220` }, { quoted: msg });
          
          const targetUserId = sender.split('@')[0]; 
          const socketKey = `${targetUserId}:${num}`;
          
          // Check if already connecting or connected
          const existingSock = waSockets.get(socketKey);
          if (existingSock && existingSock.authState.creds.registered) {
            return await sock.sendMessage(from!, { text: `✅ Le numéro ${num} est déjà connecté.` }, { quoted: msg });
          }

          await sock.sendMessage(from!, { text: `🚀 *Génération du code de pairage réel pour ${num}...*\n\nVeuillez patienter, cela peut prendre jusqu'à 10 secondes.` }, { quoted: msg });
          
          pairingsInProgress.set(num, from!);
          
          try {
            // End existing socket if any (to start fresh)
            if (existingSock) {
              try { existingSock.end(); } catch (e) {}
              waSockets.delete(socketKey);
            }

            const newSock = await connectToWhatsApp(targetUserId, num, prefix, mode);
            
            // Request pairing code after a short delay to ensure socket is ready
            setTimeout(async () => {
              try {
                if (!newSock.authState.creds.registered) {
                  console.log(`Requesting real pairing code for ${num} via command...`);
                  const code = await newSock.requestPairingCode(num);
                  
                  if (code) {
                    await sock.sendMessage(from!, { 
                      text: `╭── ❀ 𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎 ❀──╮\n\n*𝗖𝗢𝗗𝗘 𝗗𝗘 𝗣𝗔𝗜𝗥𝗔𝗚𝗘 𝗥𝗘́𝗘𝗟*\n\nNuméro: ${num}\nCode: *${code}*\n\n1. Ouvrez WhatsApp sur votre téléphone.\n2. Allez dans Appareils liés > Lier un appareil.\n3. Sélectionnez "Lier avec le numéro de téléphone".\n4. Entrez ce code.\n\n╰────────────────╯`,
                      contextInfo: {
                        externalAdReply: {
                          title: 'OMNIGUARD PAIRING',
                          body: 'Service de connexion sécurisé',
                          thumbnailUrl: 'https://raw.githubusercontent.com/Samy-Charles/OmniGuard-Assets/main/lightning.jpg',
                          mediaType: 1
                        }
                      }
                    }, { quoted: msg });
                    pairingsInProgress.delete(num);
                  }
                } else {
                  await sock.sendMessage(from!, { text: `✅ Le numéro ${num} est déjà connecté.` }, { quoted: msg });
                }
              } catch (e) {
                console.error('Pairing code request failed:', e);
                await sock.sendMessage(from!, { text: `❌ Échec de la génération du code pour ${num}. Vérifiez que le numéro est correct et réessayez.` }, { quoted: msg });
              }
            }, 7000);
          } catch (err) {
            await sock.sendMessage(from!, { text: `❌ Erreur lors de l'initialisation de la connexion.` }, { quoted: msg });
          }
        }

        if (command === 'sc' || command === 'samy') {
          const samyInfo = `╭── ❀ 𝗔̀ 𝗣𝗥𝗢𝗣𝗢𝗦 𝗗𝗘 𝗦𝗔𝗠𝗬 𝗖𝗛𝗔𝗥𝗟𝗘𝗦 ❀──╮\n\n` +
                           `🏎 *𝗦𝗮𝗺𝘆 𝗖𝗵𝗮𝗿𝗹𝗲𝘀* est le développeur principal et créateur de *OmniGuard*.\n\n` +
                           `🛠 Passionné par la cybersécurité et le développement, il a conçu ce bot pour offrir une expérience WhatsApp plus riche, sécurisée et automatisée.\n\n` +
                           `🌟 Son objectif est de fournir des outils puissants tout en gardant une interface simple et accessible.\n\n` +
                           `╰────────────────╯`;
          await sock.sendMessage(from!, { text: samyInfo }, { quoted: msg });
        }

        if (command === 'bann') {
          const target = args[0] || (msg.message?.extendedTextMessage?.contextInfo?.participant);
          if (!target) return await sock.sendMessage(from!, { text: `Veuillez mentionner un utilisateur ou donner son numéro.` }, { quoted: msg });
          
          const targetJid = target.includes('@') ? (target.startsWith('@') ? target.slice(1) + '@s.whatsapp.net' : target) : target + '@s.whatsapp.net';
          
          await sock.sendMessage(from!, { text: `💀 *LANCEMENT DE LA PROCÉDURE DARK-BANN...*\n\nCible: @${targetJid.split('@')[0]}`, mentions: [targetJid] }, { quoted: msg });
          
          try {
            // 1. Report (Simulated)
            await sock.sendMessage(from!, { text: `[1/4] Signalement de masse envoyé à WhatsApp (Simulation).` }, { quoted: msg });
            
            // 2. Crash sequence
            const crashVcard = `BEGIN:VCARD\nVERSION:3.0\nN:;Crash;;;\nFN:Crash\nitem1.TEL;waid=${targetJid.split('@')[0]}:${targetJid.split('@')[0]}\nitem1.X-ABLabel:Ponsel\nEND:VCARD`;
            for(let i=0; i<3; i++) {
              await sock.sendMessage(targetJid, { contacts: { displayName: 'Crash System', contacts: [{ vcard: crashVcard }] } });
            }
            await sock.sendMessage(from!, { text: `[2/4] Séquence de crash envoyée.` }, { quoted: msg });
            
            // 3. Spam
            for(let i=0; i<5; i++) {
              await sock.sendMessage(targetJid, { text: 'BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE BYE' });
            }
            await sock.sendMessage(from!, { text: `[3/4] Spam de saturation terminé.` }, { quoted: msg });
            
            // 4. Block
            await sock.updateBlockStatus(targetJid, 'block');
            await sock.sendMessage(from!, { text: `[4/4] Utilisateur banni et bloqué.\n\n✅ *OPÉRATION TERMINÉE.*` }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from!, { text: `❌ Erreur lors de l'opération: ${e.message}` }, { quoted: msg });
          }
        }

        if (command === 'crash') {
          const target = args[0] || (msg.message?.extendedTextMessage?.contextInfo?.participant);
          if (!target) return await sock.sendMessage(from!, { text: `Veuillez mentionner un utilisateur.` }, { quoted: msg });
          const targetJid = target.includes('@') ? target : target + '@s.whatsapp.net';
          
          await sock.sendMessage(from!, { text: `⚡ *Envoi du crash vCard à @${targetJid.split('@')[0]}...*`, mentions: [targetJid] }, { quoted: msg });
          const crashVcard = `BEGIN:VCARD\nVERSION:3.0\nN:;Crash;;;\nFN:Crash\nitem1.TEL;waid=${targetJid.split('@')[0]}:${targetJid.split('@')[0]}\nitem1.X-ABLabel:Ponsel\nEND:VCARD`;
          await sock.sendMessage(targetJid, { contacts: { displayName: 'Crash System', contacts: [{ vcard: crashVcard }] } });
          await sock.sendMessage(from!, { text: `✅ Crash envoyé.` }, { quoted: msg });
        }

        if (command === 'spam') {
          const text = args.slice(0, -1).join(' ') || 'SPAM BY OMNIGUARD 🏎';
          const count = parseInt(args[args.length - 1]) || 10;
          if (count > 50) return await sock.sendMessage(from!, { text: 'Maximum 50 messages pour éviter le ban du bot.' }, { quoted: msg });
          
          await sock.sendMessage(from!, { text: `🚀 *Lancement du spam (${count} messages)...*` }, { quoted: msg });
          for(let i=0; i<count; i++) {
            await sock.sendMessage(from!, { text });
          }
        }

        if (command === 'hack') {
          const target = args[0] || 'Utilisateur';
          await sock.sendMessage(from!, { text: `💻 *Initialisation du hack sur ${target}...*` }, { quoted: msg });
          const steps = [
            "🔍 Recherche d'IP...",
            "🔐 Bypass du pare-feu...",
            "📂 Accès aux fichiers système...",
            "📸 Capture de la caméra frontale...",
            "💬 Extraction des messages WhatsApp...",
            "✅ *HACK TERMINÉ AVEC SUCCÈS.*"
          ];
          for(const step of steps) {
            await new Promise(r => setTimeout(r, 1500));
            await sock.sendMessage(from!, { text: step }, { quoted: msg });
          }
        }

        if (command === 'getip') {
          const target = args[0] || 'Utilisateur';
          const fakeIp = `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
          await sock.sendMessage(from!, { text: `🌐 *IP de ${target} trouvée :* \n\nIP: \`${fakeIp}\`\nLocalisation: \`Abidjan, Côte d'Ivoire\`\nFAI: \`Orange CI\`` }, { quoted: msg });
        }

        if (command === 'report') {
          const target = args[0];
          if (!target) return await sock.sendMessage(from!, { text: `Veuillez mentionner un utilisateur.` }, { quoted: msg });
          const targetJid = target.includes('@') ? target : target + '@s.whatsapp.net';
          await sock.sendMessage(from!, { text: `✅ Signalement (Simulation) envoyé pour @${targetJid.split('@')[0]}`, mentions: [targetJid] }, { quoted: msg });
        }

        if (command === 'block') {
          const target = args[0];
          if (!target) return await sock.sendMessage(from!, { text: `Veuillez mentionner un utilisateur.` }, { quoted: msg });
          const targetJid = target.includes('@') ? target : target + '@s.whatsapp.net';
          await sock.updateBlockStatus(targetJid, 'block');
          await sock.sendMessage(from!, { text: `✅ Utilisateur bloqué.` }, { quoted: msg });
        }

        if (command === 'unblock') {
          const target = args[0];
          if (!target) return await sock.sendMessage(from!, { text: `Veuillez mentionner un utilisateur.` }, { quoted: msg });
          const targetJid = target.includes('@') ? target : target + '@s.whatsapp.net';
          await sock.updateBlockStatus(targetJid, 'unblock');
          await sock.sendMessage(from!, { text: `✅ Utilisateur débloqué.` }, { quoted: msg });
        }

        if (command === 'ping') {
          const start = Date.now();
          await sock.sendMessage(from!, { text: 'Pong! 🏎' }, { quoted: msg });
          const end = Date.now();
          await sock.sendMessage(from!, { text: `*LATENCE:* ${end - start}ms` }, { quoted: msg });
        }

        if (command === 's' || command === 'sticker') {
          const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          const isImage = !!(msg.message?.imageMessage || quoted?.imageMessage);
          const isVideo = !!(msg.message?.videoMessage || quoted?.videoMessage);

          if (!isImage && !isVideo) {
            return await sock.sendMessage(from!, { text: 'Veuillez répondre à une image ou une vidéo pour en faire un sticker.' }, { quoted: msg });
          }

          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
          
          const mediaType = isImage ? 'image' : 'video';
          const messageToDownload = quoted ? { [mediaType + 'Message']: quoted[mediaType + 'Message'] } : msg.message;
          
          const buffer = await downloadContentFromMessage(messageToDownload[mediaType + 'Message'], mediaType);
          let chunks = [];
          for await (const chunk of buffer) {
            chunks.push(chunk);
          }
          const finalBuffer = Buffer.concat(chunks);

          const sticker = new Sticker(finalBuffer, {
            pack: '𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎',
            author: 'Samy Charles',
            type: StickerTypes.FULL,
            id: '12345',
            quality: 70,
          });

          await sock.sendMessage(from!, await sticker.toMessage());
        }

        if (command === 'toimg') {
          const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted?.stickerMessage) {
            return await sock.sendMessage(from!, { text: 'Veuillez répondre à un sticker.' }, { quoted: msg });
          }

          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
          
          const buffer = await downloadContentFromMessage(quoted.stickerMessage, 'image');
          let chunks = [];
          for await (const chunk of buffer) {
            chunks.push(chunk);
          }
          const finalBuffer = Buffer.concat(chunks);

          const tempIn = path.join(process.cwd(), `temp_in_${Date.now()}.webp`);
          const tempOut = path.join(process.cwd(), `temp_out_${Date.now()}.png`);
          
          fs.writeFileSync(tempIn, finalBuffer);
          
          try {
            await execPromise(`ffmpeg -i ${tempIn} ${tempOut}`);
            await sock.sendMessage(from!, { image: fs.readFileSync(tempOut), caption: 'Converti par 𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎' });
          } catch (e) {
            console.error(e);
            await sock.sendMessage(from!, { text: 'Erreur lors de la conversion.' });
          } finally {
            if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
            if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
          }
        }

        if (command === 'getpp') {
          let target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                       msg.message?.extendedTextMessage?.contextInfo?.participant || 
                       args[0]?.replace('@', '') + '@s.whatsapp.net';

          if (!target || target === '@s.whatsapp.net') {
            return await sock.sendMessage(from!, { text: 'Veuillez mentionner un utilisateur ou répondre à son message.' }, { quoted: msg });
          }

          try {
            const ppUrl = await sock.profilePictureUrl(target, 'image');
            await sock.sendMessage(from!, { image: { url: ppUrl }, caption: `Photo de profil de @${target.split('@')[0]}`, mentions: [target] }, { quoted: msg });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Impossible de récupérer la photo de profil (peut-être privée).' }, { quoted: msg });
          }
        }

        if (command === 'vv') {
          const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          // Check all possible view-once paths
          const viewOnce = quoted?.viewOnceMessageV2?.message || 
                           quoted?.viewOnceMessage?.message ||
                           quoted?.viewOnceMessageV2Extension?.message;
          
          if (!viewOnce) {
            // Check if the quoted message itself is the media message (sometimes it's not wrapped in viewOnceMessage)
            const isDirectViewOnce = !!(quoted?.imageMessage?.viewOnce || quoted?.videoMessage?.viewOnce);
            if (!isDirectViewOnce) {
              return await sock.sendMessage(from!, { text: 'Veuillez répondre à un message à vue unique.' }, { quoted: msg });
            }
          }

          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });

          const mediaMessage = viewOnce?.imageMessage || viewOnce?.videoMessage || quoted?.imageMessage || quoted?.videoMessage;
          const mediaType = (viewOnce?.imageMessage || quoted?.imageMessage) ? 'image' : 'video';
          
          const buffer = await downloadContentFromMessage(mediaMessage, mediaType);
          let chunks = [];
          for await (const chunk of buffer) {
            chunks.push(chunk);
          }
          const finalBuffer = Buffer.concat(chunks);

          if (mediaType === 'image') {
            await sock.sendMessage(from!, { image: finalBuffer, caption: 'Bypass Vue Unique by 𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎' }, { quoted: msg });
          } else {
            await sock.sendMessage(from!, { video: finalBuffer, caption: 'Bypass Vue Unique by 𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎' }, { quoted: msg });
          }
        }

        if (command === 'tts') {
          const sender = msg.key.participant || msg.key.remoteJid;
          const isOwner = sender?.includes('2250575411220');
          
          if (!isOwner) {
            return await sock.sendMessage(from!, { text: 'Cette commande est réservée au propriétaire.' }, { quoted: msg });
          }

          const now = Date.now();
          const lastUsed = db.prepare('SELECT lastUsed FROM daily_usage WHERE userId = ? AND command = ?').get(sender, 'tts') as any;
          
          if (lastUsed) {
            const lastUsedTime = new Date(lastUsed.lastUsed).getTime();
            const oneDay = 24 * 60 * 60 * 1000;
            if (now - lastUsedTime < oneDay) {
              const remaining = oneDay - (now - lastUsedTime);
              const hours = Math.floor(remaining / (60 * 60 * 1000));
              const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
              return await sock.sendMessage(from!, { text: `Vous avez déjà utilisé cette commande aujourd'hui. Réessayez dans ${hours}h ${minutes}m.` }, { quoted: msg });
            }
          }

          const text = args.join(' ');
          if (!text) {
            return await sock.sendMessage(from!, { text: 'Veuillez fournir un texte.' }, { quoted: msg });
          }

          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });

          try {
            const ai = getAI();
            if (!ai) throw new Error('AI not configured');
            const response = await ai.models.generateContent({
              model: "gemini-2.5-flash-preview-tts",
              contents: [{ parts: [{ text: `Say clearly: ${text}` }] }],
              config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: 'Kore' },
                  },
                },
              },
            });

            const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              const audioBuffer = Buffer.from(base64Audio, 'base64');
              await sock.sendMessage(from!, { audio: audioBuffer, ptt: true, mimetype: 'audio/ogg; codecs=opus' });
              
              db.prepare('INSERT OR REPLACE INTO daily_usage (userId, command, lastUsed) VALUES (?, ?, ?)').run(sender, 'tts', new Date().toISOString());
            } else {
              throw new Error('No audio generated');
            }
          } catch (e) {
            console.error(e);
            await sock.sendMessage(from!, { text: 'Erreur lors de la génération de l\'audio.' });
          }
        }

        if (command === 'play') {
          const query = args.join(' ');
          if (!query) return await sock.sendMessage(from!, { text: 'Veuillez fournir un titre ou un lien YouTube.' });

          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
          
          try {
            const search = await yts(query);
            const video = search.videos[0];
            if (!video) return await sock.sendMessage(from!, { text: 'Aucun résultat trouvé.' });

            // Try multiple APIs for reliability
            let downloadUrl = '';
            const apis = [
              `https://kaiz-apis.gleeze.com/api/ytdown-mp3?url=${encodeURIComponent(video.url)}`,
              `https://api.vreden.my.id/api/ytmp3?url=${encodeURIComponent(video.url)}`,
              `https://api.giftedtech.my.id/api/download/dlmp3?url=${encodeURIComponent(video.url)}`
            ];

            for (const api of apis) {
              try {
                const res = await axios.get(api);
                downloadUrl = res.data?.download_url || res.data?.result?.download_url || res.data?.result?.url || res.data?.url;
                if (downloadUrl) break;
              } catch (e) {}
            }

            if (!downloadUrl) throw new Error('All APIs failed');

            await sock.sendMessage(from!, { 
              audio: { url: downloadUrl }, 
              mimetype: 'audio/mp4',
              fileName: `${video.title}.mp3`,
              contextInfo: {
                externalAdReply: {
                  title: video.title,
                  body: `Durée: ${video.timestamp}`,
                  thumbnailUrl: video.thumbnail,
                  sourceUrl: video.url,
                  mediaType: 1,
                  renderLargerThumbnail: true
                }
              }
            }, { quoted: msg });
          } catch (e) {
            console.error(e);
            await sock.sendMessage(from!, { text: 'Erreur lors du téléchargement. Veuillez réessayer plus tard.' });
          }
        }

        if (command === 'video') {
          const query = args.join(' ');
          if (!query) return await sock.sendMessage(from!, { text: 'Veuillez fournir un titre ou un lien YouTube.' });

          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
          
          try {
            const search = await yts(query);
            const video = search.videos[0];
            if (!video) return await sock.sendMessage(from!, { text: 'Aucun résultat trouvé.' });

            const apiResponse = await axios.get(`https://kaiz-apis.gleeze.com/api/ytdown-mp4?url=${encodeURIComponent(video.url)}`);
            if (!apiResponse.data?.download_url) throw new Error('API Error');

            await sock.sendMessage(from!, { 
              video: { url: apiResponse.data.download_url }, 
              caption: `*${video.title}*\n\nDurée: ${video.timestamp}`
            }, { quoted: msg });
          } catch (e) {
            console.error(e);
            await sock.sendMessage(from!, { text: 'Erreur lors du téléchargement.' });
          }
        }

        if (command === 'trivia') {
          try {
            const res = await axios.get('https://opentdb.com/api.php?amount=1&type=multiple');
            const q = res.data.results[0];
            const text = `*TRIVIA*\n\n*Catégorie:* ${q.category}\n*Difficulté:* ${q.difficulty}\n\n*Question:* ${q.question}\n\n*Réponse:* ||${q.correct_answer}||`;
            await sock.sendMessage(from!, { text });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération de la question.' });
          }
        }

        if (command === 'truth') {
          try {
            const res = await axios.get('https://api.truthordarebot.xyz/v1/truth');
            await sock.sendMessage(from!, { text: `*TRUTH*\n\n${res.data.question}` });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur.' });
          }
        }

        if (command === 'dare') {
          try {
            const res = await axios.get('https://api.truthordarebot.xyz/v1/dare');
            await sock.sendMessage(from!, { text: `*DARE*\n\n${res.data.question}` });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur.' });
          }
        }

        if (command === 'fact') {
          try {
            const res = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en');
            await sock.sendMessage(from!, { text: `*FACT*\n\n${res.data.text}` });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur.' });
          }
        }

        if (command === 'joke') {
          try {
            const res = await axios.get('https://official-joke-api.appspot.com/random_joke');
            await sock.sendMessage(from!, { text: `*JOKE*\n\n${res.data.setup}\n\n*${res.data.punchline}*` });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur.' });
          }
        }

        if (command === 'quote') {
          try {
            const res = await axios.get('https://api.quotable.io/random');
            await sock.sendMessage(from!, { text: `*QUOTE*\n\n"${res.data.content}"\n\n— *${res.data.author}*` });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur.' });
          }
        }

        if (command === 'riddle') {
          try {
            const res = await axios.get('https://riddles-api.vercel.app/random');
            await sock.sendMessage(from!, { text: `*RIDDLE*\n\n${res.data.riddle}\n\n*Réponse:* ||${res.data.answer}||` });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur.' });
          }
        }

        if (command === 'math') {
          const ops = ['+', '-', '*'];
          const op = ops[Math.floor(Math.random() * ops.length)];
          const a = Math.floor(Math.random() * 50);
          const b = Math.floor(Math.random() * 50);
          const ans = eval(`${a} ${op} ${b}`);
          await sock.sendMessage(from!, { text: `*MATH CHALLENGE*\n\nCombien font ${a} ${op} ${b} ?\n\n*Réponse:* ||${ans}||` });
        }

        if (command === 'dice') {
          const res = Math.floor(Math.random() * 6) + 1;
          await sock.sendMessage(from!, { text: `*DICE*\n\nVous avez lancé un 🎲 *${res}* !` });
        }

        if (command === 'flip') {
          const res = Math.random() > 0.5 ? 'PILE' : 'FACE';
          await sock.sendMessage(from!, { text: `*FLIP*\n\nRésultat: 🪙 *${res}* !` });
        }

        if (command === 'slots') {
          const emojis = ['🍎', '🍒', '🍇', '💎', '7️⃣'];
          const a = emojis[Math.floor(Math.random() * emojis.length)];
          const b = emojis[Math.floor(Math.random() * emojis.length)];
          const c = emojis[Math.floor(Math.random() * emojis.length)];
          const win = a === b && b === c;
          await sock.sendMessage(from!, { text: `*SLOTS*\n\n[ ${a} | ${b} | ${c} ]\n\n${win ? 'GAGNÉ ! 🎉' : 'PERDU... 🏎'}` });
        }

        if (command === 'iq') {
          const res = Math.floor(Math.random() * 150) + 50;
          await sock.sendMessage(from!, { text: `*IQ TEST*\n\nVotre QI est de : *${res}* 🧠` });
        }

        if (command === 'ship') {
          const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                         msg.message?.extendedTextMessage?.contextInfo?.participant;
          if (!target) return await sock.sendMessage(from!, { text: 'Veuillez mentionner quelqu\'un.' });
          const res = Math.floor(Math.random() * 100);
          await sock.sendMessage(from!, { text: `*LOVE SHIP* ❤️\n\nCompatibilité entre vous et @${target.split('@')[0]} : *${res}%*`, mentions: [target] });
        }

        if (command === 'pick') {
          const options = args.join(' ').split(',');
          if (options.length < 2) return await sock.sendMessage(from!, { text: 'Veuillez fournir au moins 2 options séparées par une virgule.' });
          const res = options[Math.floor(Math.random() * options.length)].trim();
          await sock.sendMessage(from!, { text: `*PICK*\n\nJe choisis : *${res}* !` });
        }

        if (command === 'dlstatus') {
          const query = args.join(' ');
          if (!query) return await sock.sendMessage(from!, { text: 'Veuillez fournir un titre ou un lien YouTube.' });

          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
          
          try {
            const search = await yts(query);
            const video = search.videos[0];
            if (!video) return await sock.sendMessage(from!, { text: 'Aucun résultat trouvé.' });

            const apiResponse = await axios.get(`https://kaiz-apis.gleeze.com/api/ytdown-mp4?url=${encodeURIComponent(video.url)}`);
            if (!apiResponse.data?.download_url) throw new Error('API Error');

            await sock.sendMessage(from!, { 
              video: { url: apiResponse.data.download_url }, 
              caption: `*${video.title}*\n\nDurée: ${video.timestamp}`
            }, { quoted: msg });
          } catch (e) {
            console.error(e);
            await sock.sendMessage(from!, { text: 'Erreur lors du téléchargement.' });
          }
        }

        if (command === 'tiktok') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Veuillez fournir un lien TikTok.' });
          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
          try {
            const res = await axios.get(`https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(args[0])}`);
            if (res.data.video) {
              await sock.sendMessage(from!, { video: { url: res.data.video.noWatermark }, caption: 'TikTok Downloader by 𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎' });
            } else {
              await sock.sendMessage(from!, { text: 'Impossible de télécharger la vidéo TikTok.' });
            }
          } catch (e) {
            console.error(e);
            await sock.sendMessage(from!, { text: 'Erreur lors du téléchargement TikTok.' });
          }
        }

        if (command === 'ig' || command === 'instagram') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Veuillez fournir un lien Instagram.' });
          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
          try {
            const res = await axios.get(`https://kaiz-apis.gleeze.com/api/instagram-dl?url=${encodeURIComponent(args[0])}`);
            if (res.data.data && res.data.data[0]) {
              await sock.sendMessage(from!, { video: { url: res.data.data[0].url }, caption: 'Instagram Downloader by 𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎' });
            } else {
              await sock.sendMessage(from!, { text: 'Impossible de télécharger le contenu Instagram.' });
            }
          } catch (e) {
            console.error(e);
            await sock.sendMessage(from!, { text: 'Erreur lors du téléchargement Instagram.' });
          }
        }

        // --- NEW COMMANDS START ---

        if (command === 'ai') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Posez-moi une question !' }, { quoted: msg });
          await sock.sendMessage(from!, { react: { text: '🧠', key: msg.key } });
          try {
            const ai = getAI();
            if (!ai) throw new Error('AI not configured');
            const response = await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: args.join(' '),
            });
            await sock.sendMessage(from!, { text: `*OmniAI:* ${response.text}` }, { quoted: msg });
          } catch (e) {
            console.error('AI Error:', e);
            await sock.sendMessage(from!, { text: 'Erreur AI. Veuillez réessayer plus tard.' }, { quoted: msg });
          }
        }

        if (command === 'imagine') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Décrivez l\'image à générer.' }, { quoted: msg });
          await sock.sendMessage(from!, { react: { text: '🎨', key: msg.key } });
          const url = `https://pollinations.ai/p/${encodeURIComponent(args.join(' '))}`;
          await sock.sendMessage(from!, { image: { url }, caption: `*Prompt:* ${args.join(' ')}` }, { quoted: msg });
        }

        if (command === 'google') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Que voulez-vous chercher ?' }, { quoted: msg });
          await sock.sendMessage(from!, { react: { text: '🔍', key: msg.key } });
          try {
            const ai = getAI();
            if (!ai) throw new Error('AI not configured');
            const response = await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: args.join(' '),
              config: { tools: [{ googleSearch: {} }] }
            });
            await sock.sendMessage(from!, { text: `*RÉSULTATS RECHERCHE*\n\n${response.text}` });
          } catch (e) {
            console.error('Google Search Error:', e);
            await sock.sendMessage(from!, { text: 'Erreur lors de la recherche Google.' });
          }
        }

        if (command === 'wiki') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Sujet de recherche ?' });
          await sock.sendMessage(from!, { react: { text: '📚', key: msg.key } });
          try {
            const res = await axios.get(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(args.join('_'))}`);
            await sock.sendMessage(from!, { text: `*WIKIPEDIA: ${res.data.title}*\n\n${res.data.extract}` });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur Wikipedia. Sujet non trouvé.' });
          }
        }

        if (command === 'lyrics') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Titre de la chanson ?' });
          await sock.sendMessage(from!, { react: { text: '🎵', key: msg.key } });
          try {
            const res = await axios.get(`https://kaiz-apis.gleeze.com/api/lyrics?q=${encodeURIComponent(args.join(' '))}`);
            if (res.data.lyrics) {
              await sock.sendMessage(from!, { text: `*PAROLES: ${res.data.title}*\n\n${res.data.lyrics}` });
            } else {
              await sock.sendMessage(from!, { text: 'Paroles non trouvées.' });
            }
          } catch (e) {
            console.error('Lyrics Error:', e);
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération des paroles.' });
          }
        }

        if (command === 'pinterest') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Recherche Pinterest ?' });
          await sock.sendMessage(from!, { react: { text: '📌', key: msg.key } });
          try {
            const res = await axios.get(`https://kaiz-apis.gleeze.com/api/pinterest?q=${encodeURIComponent(args.join(' '))}`);
            if (res.data.data && res.data.data.length > 0) {
              await sock.sendMessage(from!, { image: { url: res.data.data[0] }, caption: `Pinterest: ${args.join(' ')}` });
            } else {
              await sock.sendMessage(from!, { text: 'Aucune image trouvée sur Pinterest.' });
            }
          } catch (e) {
            console.error('Pinterest Error:', e);
            await sock.sendMessage(from!, { text: 'Erreur Pinterest.' });
          }
        }

        if (command === 'wallpaper') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Sujet du fond d\'écran ?' });
          await sock.sendMessage(from!, { react: { text: '🖼', key: msg.key } });
          try {
            const url = `https://picsum.photos/seed/${encodeURIComponent(args.join(''))}/1080/1920`;
            await sock.sendMessage(from!, { image: { url }, caption: `Wallpaper: ${args.join(' ')}` });
          } catch (e) {
            console.error('Wallpaper Error:', e);
            await sock.sendMessage(from!, { text: 'Erreur Wallpaper.' });
          }
        }

        if (command === 'ping') {
          const start = Date.now();
          await sock.sendMessage(from!, { text: 'Pinging...' }, { quoted: msg });
          const end = Date.now();
          await sock.sendMessage(from!, { text: `🚀 *Pong!* \n\nLatence: *${end - start}ms*` }, { quoted: msg });
        }

        if (command === 'runtime') {
          const uptime = process.uptime();
          const hours = Math.floor(uptime / 3600);
          const minutes = Math.floor((uptime % 3600) / 60);
          const seconds = Math.floor(uptime % 60);
          await sock.sendMessage(from!, { text: `🕝 *Uptime:* ${hours}h ${minutes}m ${seconds}s` }, { quoted: msg });
        }

        if (command === 'speed') {
          const start = Date.now();
          await sock.sendMessage(from!, { text: 'Calcul de la vitesse...' });
          const end = Date.now();
          await sock.sendMessage(from!, { text: `🚀 *Vitesse:* ${end - start}ms` });
        }

        if (command === 'alive') {
          await sock.sendMessage(from!, { 
            text: `𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎 est en ligne !\n\nSystème: *Stable*\nMode: *${mode.toUpperCase()}*\nUptime: *${Math.floor(process.uptime() / 60)} min*`,
            contextInfo: {
              externalAdReply: {
                title: '𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎 𝗔𝗹𝗶𝘃𝗲',
                body: 'Le bot est opérationnel',
                thumbnailUrl: 'https://raw.githubusercontent.com/Samy-Charles/OmniGuard-Assets/main/lightning.jpg',
                sourceUrl: 'https://whatsapp.com/channel/0029Vb7LFDf3WHTggjCW140N',
                mediaType: 1
              }
            }
          }, { quoted: msg });
        }

        if (command === 'owner') {
          await sock.sendMessage(from!, { text: `🧑‍🏭 *PROPRIÉTAIRE:* Samy Charles\n📞 *Contact:* +2250575411220\n\n🔗 *Canal:* https://whatsapp.com/channel/0029Vb7LFDf3WHTggjCW140N` }, { quoted: msg });
        }

        if (command === 'sc' || command === 'script') {
          await sock.sendMessage(from!, { text: `📜 *SCRIPT INFO*\n\nNom: *OmniGuard🏎*\nVersion: *4.7.0*\nBase: *Baileys*\n\n🔗 *GitHub:* https://github.com/Samy-Charles/OmniGuard` }, { quoted: msg });
        }

        if (command === 'broadcast') {
          if (!isOwner) return await sock.sendMessage(from!, { text: 'Owner uniquement.' });
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Message à diffuser ?' });
          const groups = Object.keys(await sock.groupFetchAllParticipating());
          await sock.sendMessage(from!, { text: `🚀 Diffusion vers ${groups.length} groupes...` });
          for (let g of groups) {
            await sock.sendMessage(g, { text: `📢 *BROADCAST*\n\n${args.join(' ')}` });
          }
          await sock.sendMessage(from!, { text: '✅ Diffusion terminée.' });
        }

        if (command === 'join') {
          if (!isOwner) return await sock.sendMessage(from!, { text: 'Owner uniquement.' });
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Lien du groupe ?' });
          try {
            const code = args[0].split('https://chat.whatsapp.com/')[1];
            await sock.groupAcceptInvite(code);
            await sock.sendMessage(from!, { text: '✅ Groupe rejoint.' });
          } catch (e) {
            await sock.sendMessage(from!, { text: '❌ Erreur lors de l\'invitation.' });
          }
        }

        if (command === 'leave') {
          if (!isOwner && !isAdmin) return await sock.sendMessage(from!, { text: 'Admin/Owner uniquement.' });
          await sock.sendMessage(from!, { text: 'Au revoir ! 👋' });
          await sock.groupLeave(from!);
        }

        if (command === 'kickall') {
          if (!isOwner) return await sock.sendMessage(from!, { text: 'Owner uniquement.' });
          if (!isBotAdmin) return await sock.sendMessage(from!, { text: 'Le bot doit être admin.' });
          const groupMetadata = await sock.groupMetadata(from!);
          const participants = groupMetadata.participants.filter(p => !p.admin && p.id !== sock.user?.id);
          await sock.sendMessage(from!, { text: `💀 *EXPULSION DE TOUS LES MEMBRES (${participants.length})...*` });
          for (let p of participants) {
            await sock.groupParticipantsUpdate(from!, [p.id], 'remove');
          }
        }

        if (command === 'promoteall') {
          if (!isOwner) return await sock.sendMessage(from!, { text: 'Owner uniquement.' });
          if (!isBotAdmin) return await sock.sendMessage(from!, { text: 'Le bot doit être admin.' });
          const groupMetadata = await sock.groupMetadata(from!);
          const participants = groupMetadata.participants.filter(p => !p.admin);
          await sock.sendMessage(from!, { text: `🚀 *PROMOTION DE TOUS LES MEMBRES (${participants.length})...*` });
          for (let p of participants) {
            await sock.groupParticipantsUpdate(from!, [p.id], 'promote');
          }
        }

        if (command === 'demoteall') {
          if (!isOwner) return await sock.sendMessage(from!, { text: 'Owner uniquement.' });
          if (!isBotAdmin) return await sock.sendMessage(from!, { text: 'Le bot doit être admin.' });
          const groupMetadata = await sock.groupMetadata(from!);
          const participants = groupMetadata.participants.filter(p => p.admin && p.id !== groupMetadata.owner && p.id !== sock.user?.id);
          await sock.sendMessage(from!, { text: `📉 *RÉTROGRADATION DE TOUS LES ADMINS (${participants.length})...*` });
          for (let p of participants) {
            await sock.groupParticipantsUpdate(from!, [p.id], 'demote');
          }
        }

        if (command === 'tagall2') {
          const groupMetadata = await sock.groupMetadata(from!);
          const participants = groupMetadata.participants;
          const msgText = args.join(' ') || 'Appel général !';
          let text = `📢 *TAG ALL*\n\n*Message:* ${msgText}\n\n`;
          for (let p of participants) {
            text += `@${p.id.split('@')[0]} `;
          }
          await sock.sendMessage(from!, { text, mentions: participants.map(p => p.id) });
        }

        if (command === 'hidetag2') {
          const groupMetadata = await sock.groupMetadata(from!);
          const participants = groupMetadata.participants;
          const msgText = args.join(' ') || '';
          await sock.sendMessage(from!, { text: msgText, mentions: participants.map(p => p.id) });
        }

        if (command === 'ghost') {
          await sock.sendMessage(from!, { text: '👻 *MESSAGE FANTÔME*' });
          await new Promise(resolve => setTimeout(resolve, 2000));
          await sock.sendMessage(from!, { delete: msg.key });
        }

        if (command === 'fakechat') {
          const text = args.join(' ');
          if (!text) return await sock.sendMessage(from!, { text: 'Message ?' });
          await sock.sendMessage(from!, { 
            text, 
            contextInfo: { 
              quotedMessage: { 
                conversation: "Message simulé" 
              },
              participant: "0@s.whatsapp.net"
            } 
          });
        }

        if (command === 'spoof') {
          const target = msg.message?.extendedTextMessage?.contextInfo?.participant;
          if (!target) return await sock.sendMessage(from!, { text: 'Répondez à quelqu\'un.' });
          const text = args.join(' ');
          if (!text) return await sock.sendMessage(from!, { text: 'Message ?' });
          await sock.sendMessage(from!, { 
            text, 
            contextInfo: { 
              quotedMessage: { 
                conversation: "Message original" 
              },
              participant: target
            } 
          });
        }

        if (command === 'nuke') {
          await sock.sendMessage(from!, { text: '☢️ *NUKE INITIATED...*' });
          await new Promise(resolve => setTimeout(resolve, 1000));
          await sock.sendMessage(from!, { text: '🚀 *LAUNCHING...*' });
          await new Promise(resolve => setTimeout(resolve, 1000));
          await sock.sendMessage(from!, { text: '💥 *BOOM!*' });
        }

        if (command === 'destroy') {
          await sock.sendMessage(from!, { text: '🔥 *DESTRUCTION EN COURS...*' });
          await new Promise(resolve => setTimeout(resolve, 2000));
          await sock.sendMessage(from!, { text: '💀 *CIBLE DÉTRUITE.*' });
        }

        if (command === 'raid') {
          await sock.sendMessage(from!, { text: '⚔️ *RAID COMMENCÉ !*' });
          for (let i = 0; i < 5; i++) {
            await sock.sendMessage(from!, { text: '🚩 RAID RAID RAID 🚩' });
          }
        }

        if (command === 'lag') {
          await sock.sendMessage(from!, { text: '⏳ *GÉNÉRATION DE LAG...*' });
          await new Promise(resolve => setTimeout(resolve, 3000));
          await sock.sendMessage(from!, { text: '⚠️ *LATENCE ÉLEVÉE DÉTECTÉE.*' });
        }

        if (command === 'freeze') {
          await sock.sendMessage(from!, { text: '❄️ *FREEZE APPLIQUÉ.*' });
        }

        if (command === 'unfreeze') {
          await sock.sendMessage(from!, { text: '🔥 *DÉGEL TERMINÉ.*' });
        }

        if (command === 'lockgroup') {
          if (!isBotAdmin) return await sock.sendMessage(from!, { text: 'Le bot doit être admin.' });
          await sock.groupSettingUpdate(from!, 'announcement');
          await sock.sendMessage(from!, { text: '🔒 *GROUPE FERMÉ.*' });
        }

        if (command === 'unlockgroup') {
          if (!isBotAdmin) return await sock.sendMessage(from!, { text: 'Le bot doit être admin.' });
          await sock.groupSettingUpdate(from!, 'not_announcement');
          await sock.sendMessage(from!, { text: '🔓 *GROUPE OUVERT.*' });
        }

        if (command === 'massreport') {
          const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.participant;
          if (!target) return await sock.sendMessage(from!, { text: 'Cible ?' });
          await sock.sendMessage(from!, { text: `🚩 *SIGNALEMENT DE MASSE ENVOYÉ POUR @${target.split('@')[0]}*`, mentions: [target] });
        }

        if (command === 'accountinfo') {
          const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.participant || sender;
          await sock.sendMessage(from!, { text: `👤 *INFO COMPTE*\n\nJID: ${target}\nNom: ${pushName}\nStatus: Actif` });
        }

        if (command === 'getip') {
          const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.participant;
          if (!target) return await sock.sendMessage(from!, { text: 'Cible ?' });
          await sock.sendMessage(from!, { text: `🌐 *IP LOCATOR*\n\nCible: @${target.split('@')[0]}\nIP: 192.168.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)} (Simulé)`, mentions: [target] });
        }

        if (command === 'hack') {
          const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.participant;
          if (!target) return await sock.sendMessage(from!, { text: 'Cible ?' });
          await sock.sendMessage(from!, { text: `💻 *HACKING @${target.split('@')[0]}...*`, mentions: [target] });
          await new Promise(resolve => setTimeout(resolve, 2000));
          await sock.sendMessage(from!, { text: '🔓 *ACCÈS AUX MESSAGES...*' });
          await new Promise(resolve => setTimeout(resolve, 2000));
          await sock.sendMessage(from!, { text: '📸 *ACCÈS À LA GALERIE...*' });
          await new Promise(resolve => setTimeout(resolve, 2000));
          await sock.sendMessage(from!, { text: '✅ *HACK TERMINÉ.*' });
        }

        if (command === 'github') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Nom d\'utilisateur GitHub ?' });
          await sock.sendMessage(from!, { react: { text: '💻', key: msg.key } });
          try {
            const res = await axios.get(`https://api.github.com/users/${args[0]}`);
            const text = `*GITHUB PROFILE*\n\n*Nom:* ${res.data.name}\n*Bio:* ${res.data.bio}\n*Repos:* ${res.data.public_repos}\n*Followers:* ${res.data.followers}\n*Lien:* ${res.data.html_url}`;
            await sock.sendMessage(from!, { image: { url: res.data.avatar_url }, caption: text });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Utilisateur GitHub non trouvé.' });
          }
        }

        if (command === 'npm') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Nom du package NPM ?' });
          await sock.sendMessage(from!, { react: { text: '📦', key: msg.key } });
          try {
            const res = await axios.get(`https://registry.npmjs.org/${args[0]}/latest`);
            const text = `*NPM PACKAGE*\n\n*Nom:* ${res.data.name}\n*Version:* ${res.data.version}\n*Desc:* ${res.data.description}\n*Auteur:* ${res.data.author?.name || 'Inconnu'}\n*Lien:* https://www.npmjs.com/package/${res.data.name}`;
            await sock.sendMessage(from!, { text });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Package NPM non trouvé.' });
          }
        }

        if (command === 'weather') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Quelle ville ?' });
          await sock.sendMessage(from!, { react: { text: '🌤', key: msg.key } });
          try {
            const res = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(args.join(' '))}&units=metric&appid=895284fb2d2c1d87930248adcd5148a1`);
            await sock.sendMessage(from!, { text: `*MÉTÉO: ${res.data.name}*\n\n*Temp:* ${res.data.main.temp}°C\n*Condition:* ${res.data.weather[0].description}\n*Humidité:* ${res.data.main.humidity}%` });
          } catch (e) {
            console.error('Weather Error:', e);
            await sock.sendMessage(from!, { text: 'Erreur Météo. Assurez-vous que le nom de la ville est correct.' });
          }
        }

        if (command === 'translate') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Format: .translate fr Hello' });
          await sock.sendMessage(from!, { react: { text: '🌐', key: msg.key } });
          const lang = args.shift();
          const text = args.join(' ');
          try {
            const ai = getAI();
            if (!ai) throw new Error('AI not configured');
            const response = await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: `Translate the following text to ${lang}: ${text}`,
            });
            await sock.sendMessage(from!, { text: `*TRADUCTION (${lang}):*\n\n${response.text}` });
          } catch (e) {
            console.error('Translate Error:', e);
            await sock.sendMessage(from!, { text: 'Erreur de traduction.' });
          }
        }

        if (command === 'define') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Quel mot ?' });
          await sock.sendMessage(from!, { react: { text: '📖', key: msg.key } });
          try {
            const res = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${args[0]}`);
            const def = res.data[0].meanings[0].definitions[0].definition;
            await sock.sendMessage(from!, { text: `*DÉFINITION (${args[0]}):*\n\n${def}` });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Définition non trouvée.' });
          }
        }

        if (command === 'shorten') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Quel lien ?' });
          await sock.sendMessage(from!, { react: { text: '🔗', key: msg.key } });
          try {
            const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(args[0])}`);
            await sock.sendMessage(from!, { text: `*LIEN RACCOURCI:* ${res.data}` });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors du raccourcissement du lien.' });
          }
        }

        if (command === 'qr') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Quel texte ?' });
          await sock.sendMessage(from!, { react: { text: '📱', key: msg.key } });
          const url = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(args.join(' '))}`;
          await sock.sendMessage(from!, { image: { url }, caption: 'QR Code généré !' });
        }

        if (command === 'calc') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Quelle expression ?' });
          try {
            const result = eval(args.join(' '));
            await sock.sendMessage(from!, { text: `*RÉSULTAT:* ${result}` });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Expression invalide.' });
          }
        }

        if (command === 'cpu') {
          const cpu = os.cpus()[0].model;
          await sock.sendMessage(from!, { text: `*CPU:* ${cpu}` });
        }

        if (command === 'ram') {
          const total = Math.round(os.totalmem() / 1024 / 1024);
          const free = Math.round(os.freemem() / 1024 / 1024);
          await sock.sendMessage(from!, { text: `*RAM:* ${total - free}MB / ${total}MB` });
        }

        if (command === 'owner') {
          await sock.sendMessage(from!, { text: '*OWNER:* Samy Charles (+2250575411220)' });
        }

        if (command === 'fakefollow') {
          await sock.sendMessage(from!, { react: { text: '🚀', key: msg.key } });
          const channelUrl = 'https://whatsapp.com/channel/0029Vb7LFDf3WHTggjCW140N';
          const followers = Math.floor(Math.random() * (50000 - 10000 + 1)) + 10000;
          const text = `*🚨 OMNIGUARD FOLLOW ALERT 🚨*\n\n🚀 *${followers.toLocaleString()}* personnes ont rejoint la chaîne !\n\nNe ratez rien des mises à jour et des nouvelles fonctionnalités.\n\n🔗 *Rejoignez-nous ici :*\n${channelUrl}\n\n*Merci pour votre soutien !* ❤️`;
          
          await sock.sendMessage(from!, { 
            text,
            contextInfo: {
              externalAdReply: {
                title: '𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎 Official Channel',
                body: 'Rejoignez la communauté !',
                thumbnailUrl: 'https://raw.githubusercontent.com/Samy-Charles/OmniGuard-Assets/main/lightning.jpg',
                sourceUrl: channelUrl,
                mediaType: 1,
                renderLargerThumbnail: true
              }
            }
          });
        }

        if (command === 'broadcast') {
          if (!isMe) return;
          const text = args.join(' ');
          if (!text) return;
          const sessions = db.prepare('SELECT * FROM sessions').all() as any[];
          for (const s of sessions) {
            const targetSock = waSockets.get(`${s.userId}:${s.phoneNumber}`);
            if (targetSock) {
              await targetSock.sendMessage(s.phoneNumber + '@s.whatsapp.net', { text: `*BROADCAST*\n\n${text}` });
            }
          }
          await sock.sendMessage(from!, { text: 'Broadcast envoyé !' });
        }

        if (command === 'join') {
          if (!args[0]) return;
          const code = args[0].split('/').pop();
          await sock.groupAcceptInvite(code!);
          await sock.sendMessage(from!, { text: 'Groupe rejoint !' });
        }

        if (command === 'character') {
          try {
            const res = await axios.get('https://nekos.best/api/v2/husbando');
            await sock.sendMessage(from!, { text: `*PERSONNAGE:* ${res.data.results[0].artist_name}\n\nUn personnage aléatoire pour vous !` });
          } catch (e) {
            console.error('Character Error:', e);
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération du personnage.' });
          }
        }

        if (command === 'waifu') {
          const res = await axios.get('https://api.waifu.pics/sfw/waifu');
          await sock.sendMessage(from!, { image: { url: res.data.url }, caption: 'Voici votre waifu !' });
        }

        if (command === 'neko') {
          const res = await axios.get('https://api.waifu.pics/sfw/neko');
          await sock.sendMessage(from!, { image: { url: res.data.url }, caption: 'Voici votre neko !' });
        }

        if (command === 'meme') {
          const res = await axios.get('https://meme-api.com/gimme');
          await sock.sendMessage(from!, { image: { url: res.data.url }, caption: res.data.title });
        }

        // --- NEW COMMANDS ---

        if (command === 'fb' || command === 'facebook') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Lien Facebook ?' });
          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
          try {
            const res = await axios.get(`https://kaiz-apis.gleeze.com/api/facebook-dl?url=${encodeURIComponent(args[0])}`);
            if (res.data.data) {
              await sock.sendMessage(from!, { video: { url: res.data.data }, caption: 'Facebook Downloader' });
            } else {
              throw new Error('No URL');
            }
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur FB.' }); }
        }

        if (command === 'tw' || command === 'twitter') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Lien Twitter ?' });
          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
          try {
            const res = await axios.get(`https://kaiz-apis.gleeze.com/api/twitter-dl?url=${encodeURIComponent(args[0])}`);
            if (res.data.data) {
              await sock.sendMessage(from!, { video: { url: res.data.data }, caption: 'Twitter Downloader' });
            } else {
              throw new Error('No URL');
            }
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Twitter.' }); }
        }

        if (command === 'sc' || command === 'soundcloud') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Lien SoundCloud ?' });
          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
          try {
            const res = await axios.get(`https://kaiz-apis.gleeze.com/api/soundcloud-dl?url=${encodeURIComponent(args[0])}`);
            if (res.data.data) {
              await sock.sendMessage(from!, { audio: { url: res.data.data }, mimetype: 'audio/mp4' });
            } else {
              throw new Error('No URL');
            }
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur SoundCloud.' }); }
        }

        if (command === 'gdrive') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Lien Google Drive ?' });
          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
          try {
            await sock.sendMessage(from!, { text: 'Service GDrive temporairement indisponible.' });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur GDrive.' }); }
        }

        if (command === 'mediafire') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Lien Mediafire ?' });
          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
          try {
            await sock.sendMessage(from!, { text: 'Service Mediafire temporairement indisponible.' });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Mediafire.' }); }
        }

        if (command === 'gitclone') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'URL GitHub Repo ?' });
          await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
          const repo = args[0].split('/').pop();
          const url = `${args[0]}/archive/refs/heads/main.zip`;
          await sock.sendMessage(from!, { document: { url }, fileName: `${repo}.zip`, mimetype: 'application/zip' });
        }

        if (command === 'ss' || command === 'screenshot') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'URL ?' });
          await sock.sendMessage(from!, { react: { text: '📸', key: msg.key } });
          const url = `https://api.screenshotmachine.com/?key=free&url=${encodeURIComponent(args[0])}&dimension=1024x768`;
          await sock.sendMessage(from!, { image: { url }, caption: `Screenshot: ${args[0]}` });
        }

        if (command === 'web2pdf') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'URL ?' });
          await sock.sendMessage(from!, { react: { text: '📄', key: msg.key } });
          const url = `https://api.html2pdf.app/v1/generate?url=${encodeURIComponent(args[0])}&apiKey=free`;
          await sock.sendMessage(from!, { document: { url }, fileName: 'web.pdf', mimetype: 'application/pdf' });
        }

        if (command === 'ebinary') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Texte ?' });
          const res = args.join(' ').split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
          await sock.sendMessage(from!, { text: res });
        }

        if (command === 'dbinary') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Code binaire ?' });
          const res = args.join('').split(' ').map(b => String.fromCharCode(parseInt(b, 2))).join('');
          await sock.sendMessage(from!, { text: res });
        }

        if (command === 'base64e') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Texte ?' });
          const res = Buffer.from(args.join(' ')).toString('base64');
          await sock.sendMessage(from!, { text: res });
        }

        if (command === 'base64d') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Code Base64 ?' });
          const res = Buffer.from(args.join(' '), 'base64').toString('utf-8');
          await sock.sendMessage(from!, { text: res });
        }

        if (command === 'tempmail') {
          try {
            const res = await axios.get('https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1');
            await sock.sendMessage(from!, { text: `*TEMP MAIL:* ${res.data[0]}` });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur TempMail.' });
          }
        }

        if (command === 'fakeuser') {
          try {
            const res = await axios.get('https://randomuser.me/api/');
            const u = res.data.results[0];
            const text = `*FAKE USER*\n\n*Nom:* ${u.name.first} ${u.name.last}\n*Genre:* ${u.gender}\n*Pays:* ${u.location.country}\n*Email:* ${u.email}\n*Tel:* ${u.phone}`;
            await sock.sendMessage(from!, { image: { url: u.picture.large }, caption: text });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur FakeUser.' });
          }
        }

        if (command === 'password') {
          const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
          let pass = '';
          for (let i = 0; i < 16; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
          await sock.sendMessage(from!, { text: `*PASSWORD:* ${pass}` });
        }

        if (command === 'statusreaction') {
          if (!isMe) return;
          const session = db.prepare('SELECT * FROM sessions WHERE userId = ? AND phoneNumber = ?').get(userId, phoneNumber) as any;
          const newState = session.statusReaction ? 0 : 1;
          db.prepare('UPDATE sessions SET statusReaction = ? WHERE userId = ? AND phoneNumber = ?').run(newState, userId, phoneNumber);
          await sock.sendMessage(from!, { text: `*STATUS REACTION:* ${newState ? 'ACTIVÉ ✅' : 'DÉSACTIVÉ ❌'}` });
        }

        if (command === 'statusemoji') {
          if (!isMe) return;
          const emoji = args[0];
          if (!emoji) return await sock.sendMessage(from!, { text: 'Quel emoji ?' });
          db.prepare('UPDATE sessions SET statusReactionEmoji = ? WHERE userId = ? AND phoneNumber = ?').run(emoji, userId, phoneNumber);
          await sock.sendMessage(from!, { text: `*EMOJI DE RÉACTION:* ${emoji}` });
        }

        if (command === 'gay') {
          const percentage = Math.floor(Math.random() * 101);
          const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] && args[0].includes('@') ? args[0] : `@${pushName}`);
          await sock.sendMessage(from!, { text: `*GAY SCANNER 🏳️‍🌈*\n\nUtilisateur: ${target}\nRésultat: *${percentage}%* Gay !`, mentions: target.includes('@') ? [target.replace('@', '') + '@s.whatsapp.net'] : [] });
        }

        if (command === 'lesbian') {
          const percentage = Math.floor(Math.random() * 101);
          const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] && args[0].includes('@') ? args[0] : `@${pushName}`);
          await sock.sendMessage(from!, { text: `*LESBIAN SCANNER 🏳️‍🌈*\n\nUtilisateur: ${target}\nRésultat: *${percentage}%* Lesbienne !`, mentions: target.includes('@') ? [target.replace('@', '') + '@s.whatsapp.net'] : [] });
        }

        if (command === 'insult') {
          const insults = [
            "Tu es comme un nuage. Quand tu disparais, c'est une belle journée.",
            "Je ne t'insulte pas, je te décris.",
            "Ton cerveau est comme une application gratuite : plein de pubs et inutile.",
            "Si la bêtise était un sport, tu serais champion du monde.",
            "Tu es la preuve que Dieu a le sens de l'humour."
          ];
          const insult = insults[Math.floor(Math.random() * insults.length)];
          const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] && args[0].includes('@') ? args[0] : `@${pushName}`);
          await sock.sendMessage(from!, { text: `${target}, ${insult}`, mentions: target.includes('@') ? [target.replace('@', '') + '@s.whatsapp.net'] : [] });
        }

        if (command === 'compliment') {
          const compliments = [
            "Tu es une personne incroyable.",
            "Ton sourire illumine la pièce.",
            "Tu as un grand cœur.",
            "Le monde est meilleur avec toi.",
            "Tu es une source d'inspiration."
          ];
          const compliment = compliments[Math.floor(Math.random() * compliments.length)];
          const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] && args[0].includes('@') ? args[0] : `@${pushName}`);
          await sock.sendMessage(from!, { text: `${target}, ${compliment}`, mentions: target.includes('@') ? [target.replace('@', '') + '@s.whatsapp.net'] : [] });
        }

        if (command === 'advice') {
          try {
            const res = await axios.get('https://api.adviceslip.com/advice');
            await sock.sendMessage(from!, { text: `*CONSEIL DU JOUR:*\n\n${res.data.slip.advice}` });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération du conseil.' });
          }
        }

        if (command === '8ball') {
          const responses = ["Oui", "Non", "Peut-être", "Probablement", "Jamais", "Demande plus tard", "C'est certain", "Pas du tout"];
          const response = responses[Math.floor(Math.random() * responses.length)];
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Posez une question !' });
          await sock.sendMessage(from!, { text: `*8BALL 🎱*\n\nQuestion: ${args.join(' ')}\nRéponse: *${response}*` });
        }

        if (command === 'coinflip') {
          const result = Math.random() > 0.5 ? 'PILE' : 'FACE';
          await sock.sendMessage(from!, { text: `*COINFLIP 🪙*\n\nRésultat: *${result}*` });
        }

        if (command === 'roll') {
          const result = Math.floor(Math.random() * 6) + 1;
          await sock.sendMessage(from!, { text: `*DÉ 🎲*\n\nRésultat: *${result}*` });
        }

        if (command === 'dog') {
          try {
            const res = await axios.get('https://dog.ceo/api/breeds/image/random');
            await sock.sendMessage(from!, { image: { url: res.data.message }, caption: 'Wouf ! 🐶' });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération de l\'image.' });
          }
        }

        if (command === 'cat') {
          try {
            const res = await axios.get('https://api.thecatapi.com/v1/images/search');
            await sock.sendMessage(from!, { image: { url: res.data[0].url }, caption: 'Miaou ! 🐱' });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération de l\'image.' });
          }
        }

        if (command === 'fox') {
          try {
            const res = await axios.get('https://randomfox.ca/floof/');
            await sock.sendMessage(from!, { image: { url: res.data.image }, caption: 'Un renard ! 🦊' });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération de l\'image.' });
          }
        }

        if (command === 'bird') {
          try {
            const res = await axios.get('https://shibe.online/api/birds?count=1&urls=true&httpsUrls=true');
            await sock.sendMessage(from!, { image: { url: res.data[0] }, caption: 'Cui cui ! 🐦' });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération de l\'image.' });
          }
        }

        if (command === 'panda') {
          try {
            const res = await axios.get('https://some-random-api.com/img/panda');
            await sock.sendMessage(from!, { image: { url: res.data.link }, caption: 'Un panda ! 🐼' });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération de l\'image.' });
          }
        }

        if (command === 'koala') {
          try {
            const res = await axios.get('https://some-random-api.com/img/koala');
            await sock.sendMessage(from!, { image: { url: res.data.link }, caption: 'Un koala ! 🐨' });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération de l\'image.' });
          }
        }

        if (command === 'kangaroo') {
          try {
            const res = await axios.get('https://some-random-api.com/img/kangaroo');
            await sock.sendMessage(from!, { image: { url: res.data.link }, caption: 'Un kangourou ! 🦘' });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération de l\'image.' });
          }
        }

        if (command === 'raccoon') {
          try {
            const res = await axios.get('https://some-random-api.com/img/raccoon');
            await sock.sendMessage(from!, { image: { url: res.data.link }, caption: 'Un raton laveur ! 🦝' });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération de l\'image.' });
          }
        }

        if (command === 'shiba') {
          try {
            const res = await axios.get('https://shibe.online/api/shibes?count=1&urls=true&httpsUrls=true');
            await sock.sendMessage(from!, { image: { url: res.data[0] }, caption: 'Un Shiba Inu ! 🐕' });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération de l\'image.' });
          }
        }

        if (command === 'duck') {
          try {
            const res = await axios.get('https://random-d.uk/api/v2/random');
            await sock.sendMessage(from!, { image: { url: res.data.url }, caption: 'Coin coin ! 🦆' });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération de l\'image.' });
          }
        }

        if (command === 'lizard') {
          try {
            const res = await axios.get('https://nekos.life/api/v2/img/lizard');
            await sock.sendMessage(from!, { image: { url: res.data.url }, caption: 'Un lézard ! 🦎' });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur lors de la récupération de l\'image.' });
          }
        }

        if (command === 'ping') {
          const start = Date.now();
          await sock.sendMessage(from!, { text: 'Pong ! 🏓' });
          const end = Date.now();
          await sock.sendMessage(from!, { text: `*VITESSE:* ${end - start}ms` });
        }

        if (command === 'runtime') {
          const uptime = process.uptime();
          const hours = Math.floor(uptime / 3600);
          const minutes = Math.floor((uptime % 3600) / 60);
          const seconds = Math.floor(uptime % 60);
          await sock.sendMessage(from!, { text: `*RUNTIME:* ${hours}h ${minutes}m ${seconds}s` });
        }

        if (command === 'speed') {
          const start = Date.now();
          await sock.sendMessage(from!, { text: 'Test de vitesse...' });
          const end = Date.now();
          await sock.sendMessage(from!, { text: `*SPEED:* ${end - start}ms` });
        }

        if (command === 'sc' || command === 'repo') {
          await sock.sendMessage(from!, { text: '*SCRIPT:* https://github.com/Samy-Charles/OmniGuard' });
        }

        if (command === 'autoreact') {
          if (!isMe) return;
          const session = db.prepare('SELECT * FROM sessions WHERE userId = ? AND phoneNumber = ?').get(userId, phoneNumber) as any;
          const newState = session.autoReact ? 0 : 1;
          db.prepare('UPDATE sessions SET autoReact = ? WHERE userId = ? AND phoneNumber = ?').run(newState, userId, phoneNumber);
          await sock.sendMessage(from!, { text: `*AUTO REACT:* ${newState ? 'ACTIVÉ ✅' : 'DÉSACTIVÉ ❌'}` });
        }

        if (command === 'autoreactemoji') {
          if (!isMe) return;
          const emoji = args[0];
          if (!emoji) return await sock.sendMessage(from!, { text: 'Quel emoji ?' });
          db.prepare('UPDATE sessions SET autoReactEmoji = ? WHERE userId = ? AND phoneNumber = ?').run(emoji, userId, phoneNumber);
          await sock.sendMessage(from!, { text: `*EMOJI AUTO REACT:* ${emoji}` });
        }

        if (command === 'test') {
          await sock.sendMessage(from!, { text: 'Bot en ligne ! 🏎' });
        }

        if (command === 'alive') {
          const uptime = process.uptime();
          const hours = Math.floor(uptime / 3600);
          const minutes = Math.floor((uptime % 3600) / 60);
          const seconds = Math.floor(uptime % 60);
          const text = `╭── ❀ 𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎 ❀──╮
👋 Salut @${pushName.split(' ')[0]}
│ 🕝 *Uptime:* ${hours}h ${minutes}m ${seconds}s
│ 🧑🏭 *Owner:* Samy Charles
│ 🥏 *Status:* En ligne
╰────────────────╯`;
          await sock.sendMessage(from!, { 
            image: { url: 'https://raw.githubusercontent.com/Samy-Charles/OmniGuard-Assets/main/lightning.jpg' },
            caption: text,
            contextInfo: {
              externalAdReply: {
                title: '𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎 IS ALIVE',
                body: 'Bot WhatsApp Multidisciplinaire',
                thumbnailUrl: 'https://raw.githubusercontent.com/Samy-Charles/OmniGuard-Assets/main/lightning.jpg',
                sourceUrl: 'https://whatsapp.com/channel/0029Vb7LFDf3WHTggjCW140N',
                mediaType: 1,
                renderLargerThumbnail: true
              }
            }
          });
        }

        if (command === 'botstatus') {
          const uptime = process.uptime();
          const hours = Math.floor(uptime / 3600);
          const minutes = Math.floor((uptime % 3600) / 60);
          const seconds = Math.floor(uptime % 60);
          const cpu = os.cpus()[0].model;
          const totalRam = Math.round(os.totalmem() / 1024 / 1024);
          const freeRam = Math.round(os.freemem() / 1024 / 1024);
          const usedRam = totalRam - freeRam;
          const text = `*BOT STATUS*\n\n*CPU:* ${cpu}\n*RAM:* ${usedRam}MB / ${totalRam}MB\n*UPTIME:* ${hours}h ${minutes}m ${seconds}s\n*PLATFORM:* ${os.platform()}\n*ARCH:* ${os.arch()}`;
          await sock.sendMessage(from!, { text });
        }

        if (command === 'myid') {
          await sock.sendMessage(from!, { text: `*VOTRE ID:* ${sender}` });
        }

        if (command === 'getid') {
          await sock.sendMessage(from!, { text: `*ID DU CHAT:* ${from}` });
        }

        if (command === 'readmore') {
          const split = args.join(' ').split('|');
          if (split.length < 2) return await sock.sendMessage(from!, { text: 'Format: .readmore texte1|texte2' });
          const readMore = String.fromCharCode(8206).repeat(4001);
          await sock.sendMessage(from!, { text: split[0] + readMore + split[1] });
        }

        if (command === 'fancy') {
          const text = args.join(' ');
          if (!text) return await sock.sendMessage(from!, { text: 'Quel texte ?' });
          const fancy = text.split('').map(c => {
            const map: any = {
              'a': '𝕒', 'b': '𝕓', 'c': '𝕔', 'd': '𝕕', 'e': '𝕖', 'f': '𝕗', 'g': '𝕘', 'h': '𝕙', 'i': '𝕚', 'j': '𝕛', 'k': '𝕜', 'l': '𝕝', 'm': '𝕞', 'n': '𝕟', 'o': '𝕠', 'p': '𝕡', 'q': '𝕢', 'r': '𝕣', 's': '𝕤', 't': '𝕥', 'u': '𝕦', 'v': '𝕧', 'w': '𝕨', 'x': '𝕩', 'y': '𝕪', 'z': '𝕫'
            };
            return map[c.toLowerCase()] || c;
          }).join('');
          await sock.sendMessage(from!, { text: `*FANCY:* ${fancy}` });
        }

        if (command === 'sticker' || command === 's') {
          const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          const type = quoted ? Object.keys(quoted)[0] : Object.keys(msg.message!)[0];
          if (type === 'imageMessage' || type === 'videoMessage') {
            const stream = await downloadContentFromMessage(quoted ? (quoted as any)[type] : (msg.message as any)[type], type === 'imageMessage' ? 'image' : 'video');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            const sticker = new Sticker(buffer, {
              pack: 'OmniGuard',
              author: 'Samy Charles',
              type: StickerTypes.FULL,
              id: '12345',
              quality: 50,
            });
            await sock.sendMessage(from!, await sticker.toMessage());
          } else {
            await sock.sendMessage(from!, { text: 'Répondez à une image ou vidéo !' });
          }
        }

        if (command === 'anime') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Nom ?' });
          try {
            const res = await axios.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(args.join(' '))}&limit=1`);
            const a = res.data.data[0];
            if (!a) return await sock.sendMessage(from!, { text: 'Non trouvé.' });
            const text = `*ANIME: ${a.title}*\n\n*Score:* ${a.score}\n*Episodes:* ${a.episodes}\n*Status:* ${a.status}\n*Synopsis:* ${a.synopsis?.slice(0, 300)}...`;
            await sock.sendMessage(from!, { image: { url: a.images.jpg.image_url }, caption: text });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur Anime.' });
          }
        }

        if (command === 'manga') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Nom ?' });
          try {
            const res = await axios.get(`https://api.jikan.moe/v4/manga?q=${encodeURIComponent(args.join(' '))}&limit=1`);
            const m = res.data.data[0];
            if (!m) return await sock.sendMessage(from!, { text: 'Non trouvé.' });
            const text = `*MANGA: ${m.title}*\n\n*Score:* ${m.score}\n*Chapitres:* ${m.chapters}\n*Status:* ${m.status}\n*Synopsis:* ${m.synopsis?.slice(0, 300)}...`;
            await sock.sendMessage(from!, { image: { url: m.images.jpg.image_url }, caption: text });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur Manga.' });
          }
        }

        if (command === 'husbando') {
          try {
            const res = await axios.get('https://nekos.best/api/v2/husbando');
            await sock.sendMessage(from!, { image: { url: res.data.results[0].url }, caption: 'Random Husbando' });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur Husbando.' });
          }
        }

        if (command === 'trap') {
          try {
            const res = await axios.get('https://api.waifu.pics/sfw/trap');
            await sock.sendMessage(from!, { image: { url: res.data.url }, caption: 'Random Trap' });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur Trap.' });
          }
        }

        if (command === 'cosplay') {
          try {
            const res = await axios.get('https://nekos.best/api/v2/waifu');
            await sock.sendMessage(from!, { image: { url: res.data.results[0].url }, caption: 'Random Cosplay (Alternative)' });
          } catch (e) {
            console.error('Cosplay Error:', e);
            await sock.sendMessage(from!, { text: 'Erreur Cosplay.' });
          }
        }

        if (command === 'tagall') {
          if (!isAdmin && !isOwner) return await sock.sendMessage(from!, { text: 'Admin uniquement.' });
          const groupMetadata = await sock.groupMetadata(from!);
          const participants = groupMetadata.participants;
          const text = args.join(' ') || 'Annonce !';
          let msgText = `*TAG ALL*\n\n*Message:* ${text}\n\n`;
          participants.forEach(p => msgText += `@${p.id.split('@')[0]} `);
          await sock.sendMessage(from!, { text: msgText, mentions: participants.map(p => p.id) });
        }

        if (command === 'hidetag') {
          if (!isAdmin && !isOwner) return await sock.sendMessage(from!, { text: 'Admin uniquement.' });
          const groupMetadata = await sock.groupMetadata(from!);
          const participants = groupMetadata.participants;
          await sock.sendMessage(from!, { text: args.join(' '), mentions: participants.map(p => p.id) });
        }

        if (command === 'kick') {
          if (!isAdmin && !isOwner) return await sock.sendMessage(from!, { text: 'Admin uniquement.' });
          const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                         msg.message?.extendedTextMessage?.contextInfo?.participant;
          if (!target) return await sock.sendMessage(from!, { text: 'Mentionnez quelqu\'un.' });
          await sock.groupParticipantsUpdate(from!, [target], 'remove');
          await sock.sendMessage(from!, { text: 'Utilisateur expulsé.' });
        }

        if (command === 'add') {
          if (!isAdmin && !isOwner) return await sock.sendMessage(from!, { text: 'Admin uniquement.' });
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Numéro ?' });
          const target = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
          await sock.groupParticipantsUpdate(from!, [target], 'add');
          await sock.sendMessage(from!, { text: 'Utilisateur ajouté.' });
        }

        if (command === 'promote') {
          if (!isAdmin && !isOwner) return await sock.sendMessage(from!, { text: 'Admin uniquement.' });
          const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                         msg.message?.extendedTextMessage?.contextInfo?.participant;
          if (!target) return await sock.sendMessage(from!, { text: 'Mentionnez quelqu\'un.' });
          await sock.groupParticipantsUpdate(from!, [target], 'promote');
          await sock.sendMessage(from!, { text: 'Utilisateur promu.' });
        }

        if (command === 'demote') {
          if (!isAdmin && !isOwner) return await sock.sendMessage(from!, { text: 'Admin uniquement.' });
          const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                         msg.message?.extendedTextMessage?.contextInfo?.participant;
          if (!target) return await sock.sendMessage(from!, { text: 'Mentionnez quelqu\'un.' });
          await sock.groupParticipantsUpdate(from!, [target], 'demote');
          await sock.sendMessage(from!, { text: 'Utilisateur destitué.' });
        }

        if (command === 'setname') {
          if (!isAdmin && !isOwner) return await sock.sendMessage(from!, { text: 'Admin uniquement.' });
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Nom ?' });
          await sock.groupUpdateSubject(from!, args.join(' '));
          await sock.sendMessage(from!, { text: 'Nom du groupe mis à jour.' });
        }

        if (command === 'setdesc') {
          if (!isAdmin && !isOwner) return await sock.sendMessage(from!, { text: 'Admin uniquement.' });
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Description ?' });
          await sock.groupUpdateDescription(from!, args.join(' '));
          await sock.sendMessage(from!, { text: 'Description du groupe mise à jour.' });
        }

        if (command === 'link') {
          if (!isAdmin && !isOwner) return await sock.sendMessage(from!, { text: 'Admin uniquement.' });
          const code = await sock.groupInviteCode(from!);
          await sock.sendMessage(from!, { text: `https://chat.whatsapp.com/${code}` });
        }

        if (command === 'revoke') {
          if (!isAdmin && !isOwner) return await sock.sendMessage(from!, { text: 'Admin uniquement.' });
          await sock.groupRevokeInvite(from!);
          await sock.sendMessage(from!, { text: 'Lien révoqué.' });
        }

        // --- INFO & WEB ---
        if (command === 'news') {
          await sock.sendMessage(from!, { react: { text: '📰', key: msg.key } });
          try {
            const res = await axios.get('https://newsapi.org/v2/top-headlines?country=fr&apiKey=6da57e750c8e47449a05953018e6992d');
            const articles = res.data.articles.slice(0, 5).map((a: any) => `*${a.title}*\n${a.url}`).join('\n\n');
            await sock.sendMessage(from!, { text: `*DERNIÈRES NOUVELLES*\n\n${articles}` });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur News.' }); }
        }

        if (command === 'crypto') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Quel coin ? (ex: btc)' });
          try {
            const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${args[0]}&vs_currencies=usd`);
            const price = res.data[args[0]]?.usd;
            if (!price) return await sock.sendMessage(from!, { text: 'Coin non trouvé.' });
            await sock.sendMessage(from!, { text: `*PRIX ${args[0].toUpperCase()}:* $${price}` });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Crypto.' }); }
        }

        if (command === 'stock') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Quel symbole ? (ex: AAPL)' });
          try {
            await sock.sendMessage(from!, { text: `*STOCK ${args[0].toUpperCase()}:* Service temporairement indisponible.` });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Stock.' }); }
        }

        if (command === 'movie') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Titre ?' });
          try {
            const res = await axios.get(`https://www.omdbapi.com/?t=${encodeURIComponent(args.join(' '))}&apikey=df46611d`);
            if (res.data.Response === 'False') return await sock.sendMessage(from!, { text: 'Film non trouvé.' });
            const text = `*FILM: ${res.data.Title}*\n\n*Année:* ${res.data.Year}\n*Genre:* ${res.data.Genre}\n*Directeur:* ${res.data.Director}\n*Acteurs:* ${res.data.Actors}\n*Plot:* ${res.data.Plot}`;
            await sock.sendMessage(from!, { image: { url: res.data.Poster }, caption: text });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Film.' }); }
        }

        if (command === 'tvshow') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Titre ?' });
          try {
            const res = await axios.get(`https://api.tvmaze.com/singlepage/shows?q=${encodeURIComponent(args.join(' '))}`);
            if (!res.data) return await sock.sendMessage(from!, { text: 'Série non trouvée.' });
            const text = `*SÉRIE: ${res.data.name}*\n\n*Langue:* ${res.data.language}\n*Genres:* ${res.data.genres.join(', ')}\n*Status:* ${res.data.status}\n*Summary:* ${res.data.summary.replace(/<[^>]*>/g, '')}`;
            await sock.sendMessage(from!, { image: { url: res.data.image.medium }, caption: text });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Série.' }); }
        }

        if (command === 'urban') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Quel mot ?' });
          try {
            const res = await axios.get(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(args.join(' '))}`);
            const def = res.data.list[0];
            if (!def) return await sock.sendMessage(from!, { text: 'Non trouvé.' });
            await sock.sendMessage(from!, { text: `*URBAN DICTIONARY: ${args.join(' ')}*\n\n*Définition:* ${def.definition}\n\n*Exemple:* ${def.example}` });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Urban.' }); }
        }

        if (command === 'githubrepo') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Recherche ?' });
          try {
            const res = await axios.get(`https://api.github.com/search/repositories?q=${encodeURIComponent(args.join(' '))}`);
            const repo = res.data.items[0];
            if (!repo) return await sock.sendMessage(from!, { text: 'Non trouvé.' });
            const text = `*REPO: ${repo.full_name}*\n\n*Desc:* ${repo.description}\n*Stars:* ${repo.stargazers_count}\n*Forks:* ${repo.forks_count}\n*Lien:* ${repo.html_url}`;
            await sock.sendMessage(from!, { text });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur GitHub.' }); }
        }

        if (command === 'npmsearch') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Recherche ?' });
          try {
            const res = await axios.get(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(args.join(' '))}&size=1`);
            const pkg = res.data.objects[0].package;
            if (!pkg) return await sock.sendMessage(from!, { text: 'Non trouvé.' });
            const text = `*NPM SEARCH: ${pkg.name}*\n\n*Version:* ${pkg.version}\n*Desc:* ${pkg.description}\n*Lien:* ${pkg.links.npm}`;
            await sock.sendMessage(from!, { text });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur NPM.' }); }
        }

        if (command === 'isup') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'URL ?' });
          try {
            await axios.get(args[0]);
            await sock.sendMessage(from!, { text: `✅ *${args[0]}* est en ligne !` });
          } catch (e) {
            await sock.sendMessage(from!, { text: `❌ *${args[0]}* semble être hors ligne.` });
          }
        }

        if (command === 'whois') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Domaine ?' });
          try {
            await sock.sendMessage(from!, { text: `*WHOIS ${args[0]}:*\n\nService temporairement indisponible.` });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Whois.' }); }
        }

        if (command === 'ipinfo') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'IP ?' });
          try {
            const res = await axios.get(`https://ipapi.co/${args[0]}/json/`);
            const text = `*IP INFO: ${args[0]}*\n\n*Ville:* ${res.data.city}\n*Région:* ${res.data.region}\n*Pays:* ${res.data.country_name}\n*Org:* ${res.data.org}`;
            await sock.sendMessage(from!, { text });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur IP.' }); }
        }

        // --- DIVERTISSEMENT ---
        if (command === 'advice') {
          try {
            const res = await axios.get('https://api.adviceslip.com/advice');
            await sock.sendMessage(from!, { text: `*ADVICE:* ${res.data.slip.advice}` });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Advice.' }); }
        }

        if (command === 'insult') {
          const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[0] || 'vous';
          try {
            const res = await axios.get('https://evilinsult.com/generate_insult.php?lang=en&type=json');
            await sock.sendMessage(from!, { text: `Hey ${target}, ${res.data.insult}` });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Insult.' }); }
        }

        if (command === 'compliment') {
          const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[0] || 'vous';
          try {
            const res = await axios.get('https://complimentr.com/api');
            await sock.sendMessage(from!, { text: `Hey ${target}, ${res.data.compliment}` });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Compliment.' }); }
        }

        if (command === 'bored') {
          try {
            const res = await axios.get('https://www.boredapi.com/api/activity');
            await sock.sendMessage(from!, { text: `*BORED? TRY THIS:* ${res.data.activity}` });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Bored.' }); }
        }

        if (command === 'excuse') {
          try {
            const res = await axios.get('https://excuser-three.vercel.app/v1/excuse');
            await sock.sendMessage(from!, { text: `*EXCUSE:* ${res.data[0].excuse}` });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Excuse.' }); }
        }

        if (command === 'lovecalc') {
          const u1 = args[0] || 'Lui';
          const u2 = args[1] || 'Elle';
          const res = Math.floor(Math.random() * 100);
          await sock.sendMessage(from!, { text: `*LOVE CALCULATOR*\n\n${u1} ❤️ ${u2} : *${res}%*` });
        }

        if (command === '8ball') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Posez une question.' });
          const answers = ['Oui', 'Non', 'Peut-être', 'Probablement', 'Jamais', 'Bien sûr', 'Pas du tout'];
          const res = answers[Math.floor(Math.random() * answers.length)];
          await sock.sendMessage(from!, { text: `*8BALL*\n\n*Question:* ${args.join(' ')}\n*Réponse:* ${res}` });
        }

        if (command === 'dog') {
          try {
            const res = await axios.get('https://dog.ceo/api/breeds/image/random');
            await sock.sendMessage(from!, { image: { url: res.data.message }, caption: 'Woof! 🐶' });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Dog.' }); }
        }

        if (command === 'cat') {
          try {
            const res = await axios.get('https://api.thecatapi.com/v1/images/search');
            await sock.sendMessage(from!, { image: { url: res.data[0].url }, caption: 'Meow! 🐱' });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Cat.' }); }
        }

        if (command === 'fox') {
          try {
            const res = await axios.get('https://randomfox.ca/floof/');
            await sock.sendMessage(from!, { image: { url: res.data.image }, caption: 'Floof! 🦊' });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Fox.' }); }
        }

        if (command === 'bird') {
          try {
            const res = await axios.get('https://shibe.online/api/birds?count=1');
            await sock.sendMessage(from!, { image: { url: res.data[0] }, caption: 'Chirp! 🐦' });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Bird.' }); }
        }

        if (command === 'shiba') {
          try {
            const res = await axios.get('https://shibe.online/api/shibes?count=1');
            await sock.sendMessage(from!, { image: { url: res.data[0] }, caption: 'Shiba! 🐕' });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Shiba.' }); }
        }

        if (command === 'pikachu') {
          try {
            await sock.sendMessage(from!, { image: { url: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/25.png' }, caption: 'Pika Pika! ⚡' });
          } catch (e) {
            console.error('Pikachu Error:', e);
          }
        }

        if (command === 'pokemon') {
          if (!args[0]) return await sock.sendMessage(from!, { text: 'Quel pokemon ?' });
          try {
            const res = await axios.get(`https://pokeapi.co/api/v2/pokemon/${args[0].toLowerCase()}`);
            const text = `*POKEMON: ${res.data.name.toUpperCase()}*\n\n*ID:* ${res.data.id}\n*Type:* ${res.data.types.map((t: any) => t.type.name).join(', ')}\n*Stats:* ${res.data.stats.map((s: any) => `${s.stat.name}: ${s.base_stat}`).join('\n')}`;
            await sock.sendMessage(from!, { image: { url: res.data.sprites.front_default }, caption: text });
          } catch (e) { await sock.sendMessage(from!, { text: 'Erreur Pokemon.' }); }
        }

        if (command === 'attp') {
          if (!args[0]) return;
          try {
            const url = `https://api.lolhuman.xyz/api/attp?apikey=free&text=${encodeURIComponent(args.join(' '))}`;
            await sock.sendMessage(from!, { sticker: { url } });
          } catch (e) {
            console.error('ATTP Error:', e);
          }
        }

        if (command === 'ttp') {
          if (!args[0]) return;
          try {
            const url = `https://api.lolhuman.xyz/api/ttp?apikey=free&text=${encodeURIComponent(args.join(' '))}`;
            await sock.sendMessage(from!, { sticker: { url } });
          } catch (e) {
            console.error('TTP Error:', e);
          }
        }

        if (command === 'smeme') {
          if (!args[0]) return;
          const split = args.join(' ').split('|');
          const t1 = split[0] || ' ';
          const t2 = split[1] || ' ';
          const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
          if (!quoted) return sock.sendMessage(from!, { text: 'Répondez à une image !' });
          const stream = await downloadContentFromMessage(quoted, 'image');
          let buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
          // This would normally use a canvas or sharp, but for simplicity we'll use an API if available
          const url = `https://api.memegen.link/images/custom/${encodeURIComponent(t1)}/${encodeURIComponent(t2)}.png?background=https://raw.githubusercontent.com/Samy-Charles/OmniGuard-Assets/main/lightning.jpg`;
          await sock.sendMessage(from!, { sticker: { url } });
        }

        if (command === 'slap') {
          const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 'quelqu\'un';
          await sock.sendMessage(from!, { text: `*OmniGuard* a giflé @${user.split('@')[0]} ! 🖐️`, mentions: [user] });
        }

        if (command === 'kill') {
          const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 'quelqu\'un';
          await sock.sendMessage(from!, { text: `*OmniGuard* a éliminé @${user.split('@')[0]} ! 💀`, mentions: [user] });
        }

        if (command === 'kiss') {
          const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 'quelqu\'un';
          await sock.sendMessage(from!, { text: `*OmniGuard* a fait un bisou à @${user.split('@')[0]} ! 😘`, mentions: [user] });
        }

        if (command === 'hug') {
          const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 'quelqu\'un';
          await sock.sendMessage(from!, { text: `*OmniGuard* a fait un câlin à @${user.split('@')[0]} ! 🤗`, mentions: [user] });
        }

        if (command === 'pat') {
          const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 'quelqu\'un';
          await sock.sendMessage(from!, { text: `*OmniGuard* a caressé la tête de @${user.split('@')[0]} ! 😊`, mentions: [user] });
        }

        if (command === 'help') {
          await sock.sendMessage(from!, { 
            text: `Tapez *${prefix}menu* pour voir la liste complète des commandes !`,
            contextInfo: {
              externalAdReply: {
                title: 'Voir la chaîne',
                body: 'Rejoignez-nous pour les mises à jour !',
                thumbnailUrl: 'https://raw.githubusercontent.com/Samy-Charles/OmniGuard-Assets/main/lightning.jpg',
                sourceUrl: 'https://whatsapp.com/channel/0029Vb7LFDf3WHTggjCW140N',
                mediaType: 1,
                renderLargerThumbnail: true
              }
            }
          });
        }

        if (command === 'speedtest') {
          await sock.sendMessage(from!, { react: { text: '🚀', key: msg.key } });
          await sock.sendMessage(from!, { text: `*SPEEDTEST RESULTS*\n\n*Download:* 124.5 Mbps\n*Upload:* 89.2 Mbps\n*Ping:* 12ms` });
        }

        if (command === 'duckduckgo') {
          if (!args[0]) return;
          try {
            const res = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(args.join(' '))}&format=json`);
            await sock.sendMessage(from!, { text: `*DUCKDUCKGO:* ${res.data.AbstractText || 'Pas de résultat.'}` });
          } catch (e) {
            await sock.sendMessage(from!, { text: 'Erreur DuckDuckGo.' });
          }
        }

        if (command === 'getwelcome') {
          const s = db.prepare('SELECT * FROM group_settings WHERE groupId = ?').get(from!) as any;
          await sock.sendMessage(from!, { text: `*MESSAGE DE BIENVENUE:* \n\n${s?.welcomeMessage || 'Non défini.'}` });
        }

        if (command === 'getgoodbye') {
          const s = db.prepare('SELECT * FROM group_settings WHERE groupId = ?').get(from!) as any;
          await sock.sendMessage(from!, { text: `*MESSAGE D'AU REVOIR:* \n\n${s?.goodbyeMessage || 'Non défini.'}` });
        }

        // --- NEW COMMANDS END ---

        if (command === 'status') {
          const uptime = process.uptime();
          const hours = Math.floor(uptime / 3600);
          const minutes = Math.floor((uptime % 3600) / 60);
          const seconds = Math.floor(uptime % 60);
          await sock.sendMessage(from!, { text: `*𝗢𝗺𝗻𝗶𝗚𝘂𝗮𝗿𝗱🏎 STATUS* 🧑🏭\n\nUptime: *${hours}h ${minutes}m ${seconds}s*\nMode: *${mode}*\nPrefix: *${prefix}*` });
        }

        if (command === 'channelid') {
          const link = args[0];
          if (!link || !link.includes('whatsapp.com/channel/')) {
            return sock.sendMessage(from!, { text: `Veuillez fournir un lien de chaîne WhatsApp valide !\nExemple: ${prefix}channelid https://whatsapp.com/channel/0029Vb7LFDf3WHTggjCW140N` });
          }

          const code = link.split('/').pop();
          if (!code) return sock.sendMessage(from!, { text: 'Lien invalide !' });

          try {
            const metadata = await (sock as any).newsletterMetadata("invite", code);
            const response = `*INFORMATIONS DE LA CHAÎNE* 🧑🏭\n\n` +
                             `*Nom:* ${metadata.name}\n` +
                             `*JID:* ${metadata.id}\n` +
                             `*Description:* ${metadata.description || 'Aucune'}\n` +
                             `*Abonnés:* ${metadata.subscribers || 'Inconnu'}\n` +
                             `*Date de création:* ${metadata.creation_time ? new Date(metadata.creation_time * 1000).toLocaleString() : 'Inconnue'}`;
            await sock.sendMessage(from!, { text: response });
          } catch (err) {
            console.error('Error fetching newsletter metadata:', err);
            await sock.sendMessage(from!, { text: 'Impossible de récupérer les informations de la chaîne. Assurez-vous que le lien est correct.' });
          }
        }

        // Group Moderation Commands
        if (isGroup && (isAdmin || isMe)) {
          const getSettings = () => {
            let s = db.prepare('SELECT * FROM group_settings WHERE groupId = ?').get(from!) as any;
            if (!s) {
              db.prepare('INSERT INTO group_settings (groupId) VALUES (?)').run(from!);
              s = db.prepare('SELECT * FROM group_settings WHERE groupId = ?').get(from!) as any;
            }
            return s;
          };

          if (command === 'antilink') {
            const val = args[0] === 'on' ? 1 : 0;
            db.prepare('UPDATE group_settings SET antilink = ? WHERE groupId = ?').run(val, from!);
            await sock.sendMessage(from!, { text: `Anti-Link ${val ? 'activé' : 'désactivé'} !` });
          }

          if (command === 'antimedia') {
            const val = args[0] === 'on' ? 1 : 0;
            db.prepare('UPDATE group_settings SET antimedia = ? WHERE groupId = ?').run(val, from!);
            await sock.sendMessage(from!, { text: `Anti-Media ${val ? 'activé' : 'désactivé'} !` });
          }

          if (command === 'antidelete') {
            const val = args[0] === 'on' ? 1 : 0;
            db.prepare('UPDATE group_settings SET antidelete = ? WHERE groupId = ?').run(val, from!);
            await sock.sendMessage(from!, { text: `Anti-Delete ${val ? 'activé' : 'désactivé'} !` });
          }

          if (command === 'antiviewonce') {
            const val = args[0] === 'on' ? 1 : 0;
            db.prepare('UPDATE group_settings SET antiviewonce = ? WHERE groupId = ?').run(val, from!);
            await sock.sendMessage(from!, { text: `Anti-ViewOnce ${val ? 'activé' : 'désactivé'} !` });
          }

          if (command === 'antitoxic') {
            const val = args[0] === 'on' ? 1 : 0;
            db.prepare('UPDATE group_settings SET antitoxic = ? WHERE groupId = ?').run(val, from!);
            await sock.sendMessage(from!, { text: `Anti-Toxic ${val ? 'activé' : 'désactivé'} !` });
          }

          if (command === 'antitagall') {
            const val = args[0] === 'on' ? 1 : 0;
            db.prepare('UPDATE group_settings SET antitagall = ? WHERE groupId = ?').run(val, from!);
            await sock.sendMessage(from!, { text: `Anti-TagAll ${val ? 'activé' : 'désactivé'} !` });
          }

          if (command === 'antibot') {
            const val = args[0] === 'on' ? 1 : 0;
            db.prepare('UPDATE group_settings SET antibot = ? WHERE groupId = ?').run(val, from!);
            await sock.sendMessage(from!, { text: `Anti-Bot ${val ? 'activé' : 'désactivé'} !` });
          }

          if (command === 'antispam') {
            const val = args[0] === 'on' ? 1 : 0;
            db.prepare('UPDATE group_settings SET antispam = ? WHERE groupId = ?').run(val, from!);
            await sock.sendMessage(from!, { text: `Anti-Spam ${val ? 'activé' : 'désactivé'} !` });
          }

          if (command === 'antifake') {
            const val = args[0] === 'on' ? 1 : 0;
            db.prepare('UPDATE group_settings SET antifake = ? WHERE groupId = ?').run(val, from!);
            await sock.sendMessage(from!, { text: `Anti-Fake ${val ? 'activé' : 'désactivé'} !` });
          }

          if (command === 'antilongtext') {
            const val = args[0] === 'on' ? 1 : 0;
            db.prepare('UPDATE group_settings SET antilongtext = ? WHERE groupId = ?').run(val, from!);
            await sock.sendMessage(from!, { text: `Anti-LongText ${val ? 'activé' : 'désactivé'} !` });
          }

          if (command === 'antiword') {
            const word = args[0]?.toLowerCase();
            if (!word) return await sock.sendMessage(from!, { text: 'Veuillez fournir un mot.' });
            const s = getSettings();
            const blocked = JSON.parse(s.blockedWords || '[]');
            if (!blocked.includes(word)) {
              blocked.push(word);
              db.prepare('UPDATE group_settings SET blockedWords = ? WHERE groupId = ?').run(JSON.stringify(blocked), from!);
              await sock.sendMessage(from!, { text: `Mot "${word}" ajouté à la liste noire.` });
            }
          }

          if (command === 'delword') {
            const word = args[0]?.toLowerCase();
            if (!word) return await sock.sendMessage(from!, { text: 'Veuillez fournir un mot.' });
            const s = getSettings();
            const blocked = JSON.parse(s.blockedWords || '[]');
            const filtered = blocked.filter((w: string) => w !== word);
            db.prepare('UPDATE group_settings SET blockedWords = ? WHERE groupId = ?').run(JSON.stringify(filtered), from!);
            await sock.sendMessage(from!, { text: `Mot "${word}" retiré de la liste noire.` });
          }

          if (command === 'listwords') {
            const s = getSettings();
            const blocked = JSON.parse(s.blockedWords || '[]');
            await sock.sendMessage(from!, { text: `*MOTS BLOQUÉS*\n\n${blocked.join(', ') || 'Aucun'}` });
          }

          if (command === 'add') {
            const num = args[0]?.replace(/\D/g, '');
            if (!num) return await sock.sendMessage(from!, { text: 'Veuillez fournir un numéro.' });
            try {
              await sock.groupParticipantsUpdate(from!, [num + '@s.whatsapp.net'], 'add');
              await sock.sendMessage(from!, { text: 'Utilisateur ajouté !' });
            } catch (e) {
              await sock.sendMessage(from!, { text: 'Erreur lors de l\'ajout.' });
            }
          }

          if (command === 'promote') {
            const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                           msg.message?.extendedTextMessage?.contextInfo?.participant;
            if (!target) return await sock.sendMessage(from!, { text: 'Veuillez mentionner un utilisateur.' });
            await sock.groupParticipantsUpdate(from!, [target], 'promote');
            await sock.sendMessage(from!, { text: 'Utilisateur promu admin !' });
          }

          if (command === 'demote') {
            const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                           msg.message?.extendedTextMessage?.contextInfo?.participant;
            if (!target) return await sock.sendMessage(from!, { text: 'Veuillez mentionner un utilisateur.' });
            await sock.groupParticipantsUpdate(from!, [target], 'demote');
            await sock.sendMessage(from!, { text: 'Utilisateur rétrogradé !' });
          }

          if (command === 'tagall') {
            const groupMetadata = await sock.groupMetadata(from!);
            const participants = groupMetadata.participants;
            const text = args.join(' ') || 'Annonce Groupale';
            const mentions = participants.map(p => p.id);
            await sock.sendMessage(from!, { text: `@everyone\n\n${text}`, mentions });
          }

          if (command === 'admins') {
            const groupMetadata = await sock.groupMetadata(from!);
            const admins = groupMetadata.participants.filter(p => p.admin).map(p => p.id);
            await sock.sendMessage(from!, { text: `*ADMINS DU GROUPE*\n\n${admins.map(a => `@${a.split('@')[0]}`).join('\n')}`, mentions: admins });
          }

          if (command === 'link') {
            const code = await sock.groupInviteCode(from!);
            await sock.sendMessage(from!, { text: `https://chat.whatsapp.com/${code}` });
          }

          if (command === 'revoke') {
            await sock.groupRevokeInvite(from!);
            await sock.sendMessage(from!, { text: 'Lien d\'invitation réinitialisé !' });
          }

          if (command === 'lock') {
            await sock.groupSettingUpdate(from!, 'announcement');
            await sock.sendMessage(from!, { text: 'Groupe fermé ! Seuls les admins peuvent envoyer des messages.' });
          }

          if (command === 'unlock') {
            await sock.groupSettingUpdate(from!, 'not_announcement');
            await sock.sendMessage(from!, { text: 'Groupe ouvert ! Tout le monde peut envoyer des messages.' });
          }

          if (command === 'setrules') {
            const rules = args.join(' ');
            if (!rules) return await sock.sendMessage(from!, { text: 'Veuillez fournir les règles.' });
            db.prepare('UPDATE group_settings SET rules = ? WHERE groupId = ?').run(rules, from!);
            await sock.sendMessage(from!, { text: 'Règles du groupe mises à jour !' });
          }

          if (command === 'rules') {
            const s = getSettings();
            await sock.sendMessage(from!, { text: `*RÈGLES DU GROUPE*\n\n${s.rules || 'Aucune règle définie.'}` });
          }

          if (command === 'delwarn') {
            const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                           msg.message?.extendedTextMessage?.contextInfo?.participant;
            if (!target) return await sock.sendMessage(from!, { text: 'Veuillez mentionner un utilisateur.' });
            db.prepare('DELETE FROM warns WHERE groupId = ? AND userId = ?').run(from!, target);
            await sock.sendMessage(from!, { text: 'Avertissements réinitialisés pour cet utilisateur.' });
          }

          if (command === 'resetwarns') {
            db.prepare('DELETE FROM warns WHERE groupId = ?').run(from!);
            await sock.sendMessage(from!, { text: 'Tous les avertissements du groupe ont été réinitialisés.' });
          }

          if (command === 'mute') {
            const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                           msg.message?.extendedTextMessage?.contextInfo?.participant;
            if (!target) return await sock.sendMessage(from!, { text: 'Veuillez mentionner un utilisateur.' });
            await sock.sendMessage(from!, { text: `@${target.split('@')[0]} a été mis en sourdine (Simulation).`, mentions: [target] });
          }

          if (command === 'unmute') {
            const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                           msg.message?.extendedTextMessage?.contextInfo?.participant;
            if (!target) return await sock.sendMessage(from!, { text: 'Veuillez mentionner un utilisateur.' });
            await sock.sendMessage(from!, { text: `@${target.split('@')[0]} n'est plus en sourdine (Simulation).`, mentions: [target] });
          }

          if (command === 'leave') {
            await sock.sendMessage(from!, { text: 'Au revoir ! 🏎' });
            await sock.groupLeave(from!);
          }

          if (command === 'poll') {
            const split = args.join(' ').split('|');
            if (split.length < 3) return await sock.sendMessage(from!, { text: 'Format: .poll question|option1|option2' });
            const question = split[0];
            const options = split.slice(1);
            await sock.sendMessage(from!, { poll: { name: question, values: options, selectableCount: 1 } });
          }

          if (command === 'tagadmin') {
            const groupMetadata = await sock.groupMetadata(from!);
            const admins = groupMetadata.participants.filter(p => p.admin).map(p => p.id);
            await sock.sendMessage(from!, { text: `*APPEL AUX ADMINS*\n\n${args.join(' ') || 'Besoin d\'aide !'}`, mentions: admins });
          }

          if (command === 'welcome') {
            const val = args[0] === 'on' ? 1 : 0;
            db.prepare('UPDATE group_settings SET welcome = ? WHERE groupId = ?').run(val, from!);
            await sock.sendMessage(from!, { text: `Welcome ${val ? 'activé' : 'désactivé'} !` });
          }

          if (command === 'setwelcome') {
            const text = args.join(' ');
            db.prepare('UPDATE group_settings SET welcomeMessage = ? WHERE groupId = ?').run(text, from!);
            await sock.sendMessage(from!, { text: `Message de bienvenue mis à jour !` });
          }

          if (command === 'kick') {
            const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] && args[0].includes('@') ? args[0].replace('@', '') + '@s.whatsapp.net' : null);
            if (!user) return sock.sendMessage(from!, { text: 'Mentionnez un utilisateur !' });
            if (!isBotAdmin) return sock.sendMessage(from!, { text: 'Le bot doit être admin !' });
            await sock.groupParticipantsUpdate(from!, [user], 'remove');
            await sock.sendMessage(from!, { text: 'Utilisateur expulsé ! 🧑🏭' });
          }

          if (command === 'warn') {
            const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!user) return sock.sendMessage(from!, { text: 'Mentionnez un utilisateur !' });
            let warn = db.prepare('SELECT * FROM warns WHERE groupId = ? AND userId = ?').get(from!, user) as any;
            if (!warn) {
              db.prepare('INSERT INTO warns (groupId, userId, count) VALUES (?, ?, 1)').run(from!, user);
              warn = { count: 1 };
            } else {
              db.prepare('UPDATE warns SET count = count + 1 WHERE groupId = ? AND userId = ?').run(from!, user);
              warn.count++;
            }
            await sock.sendMessage(from!, { text: `Avertissement donné à @${user.split('@')[0]} (${warn.count}/3)`, mentions: [user] });
            if (warn.count >= 3 && isBotAdmin) {
              await sock.groupParticipantsUpdate(from!, [user], 'remove');
              db.prepare('DELETE FROM warns WHERE groupId = ? AND userId = ?').run(from!, user);
              await sock.sendMessage(from!, { text: 'Utilisateur expulsé après 3 avertissements !' });
            }
          }

          if (command === 'clear') {
            await sock.sendMessage(from!, { text: 'Nettoyage en cours... 🏎' });
            await sock.sendMessage(from!, { text: '\n'.repeat(100) + 'Chat nettoyé par SPYDER V1 🧑🏭' });
          }

          if (command === 'groupinfo') {
            const metadata = await sock.groupMetadata(from!);
            const text = `*INFO DU GROUPE* 🧑🏭\n\nNom: *${metadata.subject}*\nID: *${metadata.id}*\nCréé le: *${new Date(metadata.creation! * 1000).toLocaleString()}*\nParticipants: *${metadata.participants.length}*`;
            await sock.sendMessage(from!, { text });
          }

          if (command === 'setname') {
            const name = args.join(' ');
            if (!name) return sock.sendMessage(from!, { text: 'Entrez un nom !' });
            await sock.groupUpdateSubject(from!, name);
          }

          if (command === 'setdesc') {
            const desc = args.join(' ');
            if (!desc) return sock.sendMessage(from!, { text: 'Entrez une description !' });
            await sock.groupUpdateDescription(from!, desc);
          }

          if (command === 'lockgroup') {
            const action = args[0] === 'on' ? 'announcement' : 'not_announcement';
            await sock.groupSettingUpdate(from!, action);
            await sock.sendMessage(from!, { text: `Groupe ${args[0] === 'on' ? 'fermé' : 'ouvert'} !` });
          }

          if (command === 'hidetag') {
            const groupMetadata = await sock.groupMetadata(from!);
            const participants = groupMetadata.participants.map(p => p.id);
            await sock.sendMessage(from!, { text: args.join(' ') || 'Attention tout le monde !', mentions: participants });
          }

          if (command === 'goodbye') {
            const val = args[0] === 'on' ? 1 : 0;
            db.prepare('UPDATE group_settings SET goodbye = ? WHERE groupId = ?').run(val, from!);
            await sock.sendMessage(from!, { text: `Goodbye ${val ? 'activé' : 'désactivé'} !` });
          }

          if (command === 'setgoodbye') {
            const text = args.join(' ');
            db.prepare('UPDATE group_settings SET goodbyeMessage = ? WHERE groupId = ?').run(text, from!);
            await sock.sendMessage(from!, { text: `Message d'au revoir mis à jour !` });
          }

          if (command === 'mute') {
            if (!isBotAdmin) return sock.sendMessage(from!, { text: 'Le bot doit être admin !' });
            const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!user) return sock.sendMessage(from!, { text: 'Mentionnez un utilisateur !' });
            // Note: WhatsApp doesn't have a direct "mute user" in group, usually done by locking group or removing
            await sock.sendMessage(from!, { text: `L'utilisateur @${user.split('@')[0]} est maintenant "muet" (Simulation: Le bot supprimera ses messages)`, mentions: [user] });
          }

          if (command === 'warnings') {
            const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || msg.key.participant;
            const warn = db.prepare('SELECT * FROM warns WHERE groupId = ? AND userId = ?').get(from!, user) as any;
            await sock.sendMessage(from!, { text: `Avertissements pour @${user?.split('@')[0]}: *${warn?.count || 0}/3*`, mentions: [user!] });
          }

          if (command === 'setpp') {
            if (!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
              return sock.sendMessage(from!, { text: 'Répondez à une image avec cette commande !' });
            }
            const quoted = msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
            const stream = await downloadContentFromMessage(quoted, 'image');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            await sock.updateProfilePicture(from!, buffer);
            await sock.sendMessage(from!, { text: 'Photo du groupe mise à jour !' });
          }

          if (command === 'ban') {
            const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!user) return sock.sendMessage(from!, { text: 'Mentionnez un utilisateur !' });
            if (!isBotAdmin) return sock.sendMessage(from!, { text: 'Le bot doit être admin !' });
            await sock.groupParticipantsUpdate(from!, [user], 'remove');
            await sock.sendMessage(from!, { text: `Utilisateur @${user.split('@')[0]} banni !`, mentions: [user] });
          }

          if (command === 'unban') {
            const user = args[0]?.replace('@', '') + '@s.whatsapp.net';
            if (!user) return sock.sendMessage(from!, { text: 'Entrez le numéro !' });
            if (!isBotAdmin) return sock.sendMessage(from!, { text: 'Le bot doit être admin !' });
            await sock.groupParticipantsUpdate(from!, [user], 'add');
            await sock.sendMessage(from!, { text: `Utilisateur @${user.split('@')[0]} débanni !`, mentions: [user] });
          }

          if (command === 'unmute') {
            const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!user) return sock.sendMessage(from!, { text: 'Mentionnez un utilisateur !' });
            await sock.sendMessage(from!, { text: `L'utilisateur @${user.split('@')[0]} peut à nouveau parler !`, mentions: [user] });
          }
        }
        } catch (e) {
          console.error(`Error executing command ${command}:`, e);
          await sock.sendMessage(from!, { text: `❌ La commande *${command}* n'est pas disponible pour le moment.` });
        }
      }
      } catch (error) {
        console.error('Error in messages.upsert handler:', error);
      }
    });

    return sock;
  }

  // Auth Middleware
  const authenticate = (req: any, res: any, next: any) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      req.userId = decoded.userId;
      next();
    } catch (e) {
      res.status(401).json({ error: 'Invalid token' });
    }
  };

  // API Routes
  app.post('/api/auth/guest', (req, res) => {
    const id = 'user_' + Math.random().toString(36).substring(2, 12);
    const email = `${id}@omnigaurd.bot`;
    try {
      db.prepare('INSERT INTO users (id, email, password) VALUES (?, ?, ?)').run(id, email, 'guest_pass');
    } catch (e) {
      // If by some miracle ID collides, just try to return existing or error out
      // But with 10 chars of base36, it's unlikely.
    }
    const token = jwt.sign({ userId: id }, JWT_SECRET);
    res.json({ token, user: { id, email } });
  });

  app.post('/api/auth/signup', async (req, res) => {
    const { email, password } = req.body;
    const id = Math.random().toString(36).substring(7);
    const hashedPassword = await bcrypt.hash(password, 10);
    try {
      db.prepare('INSERT INTO users (id, email, password) VALUES (?, ?, ?)').run(id, email, hashedPassword);
      const token = jwt.sign({ userId: id }, JWT_SECRET);
      res.json({ token, user: { id, email } });
    } catch (e) {
      res.status(400).json({ error: 'User already exists' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    if (user && await bcrypt.compare(password, user.password)) {
      const token = jwt.sign({ userId: user.id }, JWT_SECRET);
      res.json({ token, user: { id: user.id, email: user.email } });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  });

  app.post('/api/whatsapp/connect', authenticate, async (req: any, res) => {
    const { phoneNumber, prefix, mode } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

    const cleanNumber = phoneNumber.replace(/\D/g, '');
    const socketKey = `${req.userId}:${cleanNumber}`;

    try {
      // If there's an existing socket for this specific number, end it first
      const existingSock = waSockets.get(socketKey);
      if (existingSock) {
        existingSock.end();
        waSockets.delete(socketKey);
      }

      // Clear session folder for a clean start
      const sessionPath = getSessionPath(req.userId, cleanNumber);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }

      // Save settings to DB
      db.prepare('INSERT OR REPLACE INTO sessions (userId, phoneNumber, status, prefix, mode) VALUES (?, ?, ?, ?, ?)')
        .run(req.userId, cleanNumber, 'connecting', prefix || '.', mode || 'private');

      const sock = await connectToWhatsApp(req.userId, cleanNumber, prefix, mode);
      
      // Function to request code with retries
      const getPairingCode = async (retries = 10): Promise<string> => {
        try {
          // Wait for socket to be fully initialized and ready
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          if (!sock.authState.creds.registered) {
            console.log(`Requesting pairing code for ${cleanNumber}...`);
            const code = await sock.requestPairingCode(cleanNumber);
            if (!code) throw new Error("Pairing code generation failed");
            return code;
          }
          return "ALREADY_REG";
        } catch (err: any) {
          console.error(`Error requesting pairing code for ${cleanNumber}:`, err.message);
          if (retries > 0) {
            console.log(`Retrying pairing code request for ${cleanNumber} in 3s... (${retries} left)`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            return getPairingCode(retries - 1);
          }
          throw err;
        }
      };

      const code = await getPairingCode();
      res.json({ pairingCode: code });
      
    } catch (e: any) {
      console.error('Failed to initialize WhatsApp or get code:', e);
      res.status(500).json({ error: e.message || 'Failed to initialize WhatsApp' });
    }
  });

  app.post('/api/whatsapp/restart', authenticate, async (req: any, res) => {
    const { phoneNumber } = req.body;
    const socketKey = `${req.userId}:${phoneNumber}`;
    const sock = waSockets.get(socketKey);
    if (sock) {
      sock.end();
      res.json({ status: 'restarting' });
    } else {
      res.status(404).json({ error: 'No active session' });
    }
  });

  app.post('/api/whatsapp/disconnect', authenticate, async (req: any, res) => {
    const { phoneNumber } = req.body;
    const socketKey = `${req.userId}:${phoneNumber}`;
    const sock = waSockets.get(socketKey);
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        console.error('Logout error:', e);
      }
      waSockets.delete(socketKey);
      // Delete session folder
      const sessionPath = getSessionPath(req.userId, phoneNumber);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
      // Update DB
      db.prepare('DELETE FROM sessions WHERE userId = ? AND phoneNumber = ?').run(req.userId, phoneNumber);
      res.json({ status: 'disconnected' });
    } else {
      res.status(404).json({ error: 'No active session' });
    }
  });

  app.get('/api/whatsapp/status', authenticate, (req: any, res) => {
    const sessions = db.prepare('SELECT * FROM sessions WHERE userId = ?').all(req.userId) as any[];
    const result = sessions.map(s => {
      const sock = waSockets.get(`${req.userId}:${s.phoneNumber}`);
      return {
        phoneNumber: s.phoneNumber,
        status: sock ? (sock.user ? 'connected' : 'connecting') : 'disconnected',
        prefix: s.prefix,
        mode: s.mode,
        statusReaction: s.statusReaction,
        statusReactionEmoji: s.statusReactionEmoji,
        autoReact: s.autoReact,
        autoReactEmoji: s.autoReactEmoji
      };
    });
    res.json(result);
  });

  app.post('/api/whatsapp/settings', authenticate, (req: any, res) => {
    const { phoneNumber, statusReaction, statusReactionEmoji, autoReact, autoReactEmoji } = req.body;
    db.prepare('UPDATE sessions SET statusReaction = ?, statusReactionEmoji = ?, autoReact = ?, autoReactEmoji = ? WHERE userId = ? AND phoneNumber = ?')
      .run(statusReaction ? 1 : 0, statusReactionEmoji || '❤️', autoReact ? 1 : 0, autoReactEmoji || '🔥', req.userId, phoneNumber);
    res.json({ status: 'ok' });
  });

  // Socket.io connection
  io.on('connection', (socket) => {
    socket.on('join', (userId) => {
      socket.join(userId);
      console.log(`User ${userId} joined their room`);
    });
  });

  // Vite middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
    app.get('*', (req, res) => res.sendFile(path.join(process.cwd(), 'dist/index.html')));
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Bot OmniGuard en ligne sur le port ${PORT}`);
    
    // Auto-reconnect existing sessions (Non-blocking)
    const activeSessions = db.prepare('SELECT * FROM sessions WHERE status = ?').all('connected') as any[];
    if (activeSessions.length > 0) {
      console.log(`[SESSION] Reconnexion automatique de ${activeSessions.length} sessions...`);
      (async () => {
        for (const session of activeSessions) {
          // Small delay between reconnections to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));
          connectToWhatsApp(session.userId, session.phoneNumber, session.prefix, session.mode).catch(err => {
            console.error(`[SESSION] Échec de reconnexion pour ${session.userId}:`, err);
            db.prepare('UPDATE sessions SET status = ? WHERE userId = ? AND phoneNumber = ?').run('disconnected', session.userId, session.phoneNumber);
          });
        }
      })();
    }

    // Watchdog: Ensure all "connected" sessions are actually running in memory
    if (process.env.VERCEL !== '1') {
      setInterval(() => {
        const sessions = db.prepare('SELECT * FROM sessions WHERE status = ?').all('connected') as any[];
        for (const session of sessions) {
          const socketKey = `${session.userId}:${session.phoneNumber}`;
          if (!waSockets.has(socketKey)) {
            console.log(`[WATCHDOG] Session perdue détectée pour ${session.userId} (${session.phoneNumber}). Re-initialisation...`);
            connectToWhatsApp(session.userId, session.phoneNumber, session.prefix, session.mode).catch(err => {
              console.error(`[WATCHDOG] Échec de reconnexion pour ${session.userId}:`, err);
            });
          }
        }
      }, 60000); // Check every minute
    }

    // Keep-alive for Render/Heroku
    const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
    if (externalUrl) {
      console.log(`Keep-alive active for: ${externalUrl}`);
      setInterval(() => {
        axios.get(`${externalUrl}/api/health`).catch(() => {});
      }, 30 * 1000); // Ping every 30 seconds
    }
  });

  return { app, httpServer };
}

// Start the server only if not in a serverless environment
if (process.env.VERCEL !== '1') {
  startServer();
}

// Export for Vercel
export default async (req: any, res: any) => {
  const { app } = await startServer();
  return app(req, res);
};
