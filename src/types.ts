export interface User {
  id: string;
  email: string;
  passwordHash: string;
}

export interface WhatsAppSession {
  userId: string;
  phoneNumber: string;
  status: 'disconnected' | 'connecting' | 'connected';
  pairingCode?: string;
  lastUpdate: number;
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
  };
}
