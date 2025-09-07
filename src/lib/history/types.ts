export type Direction = 'inbound' | 'outbound' | 'system';
export type CallStatus = 'active' | 'completed' | 'missed' | 'failed' | 'voicemail';

export interface CallRecordV2 {
  id: string; // stable id (e.g., code-timestamp for nurse calls)
  externalId?: string; // for PBX/VoIP integrations
  direction: Direction;
  code?: string; // nurse-call code (legacy)
  room?: string;
  bed?: string;
  startedAt: string; // ISO
  endedAt?: string; // ISO
  status: CallStatus;
  durationSec?: number;
  tags?: string[];
  notes?: string;
  // soft delete
  deletedAt?: string;
  deletedReason?: string;
}

export interface HistoryV2File {
  version: 2;
  calls: CallRecordV2[];
}

