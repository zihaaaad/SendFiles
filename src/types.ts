/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface FileMeta {
  name: string;
  size: number;
  type: string;
}

export interface RoomDetails {
  roomId: string;
  hasPassword: boolean;
  expiresAt: number;
  maxDownloads: number;
  downloadCount: number;
  files: FileMeta[];
}

export type TransferState = "idle" | "connecting" | "transferring" | "complete" | "failed" | "interrupted";

export interface TransferProgress {
  fileIndex: number;
  fileName: string;
  fileSize: number;
  bytesSentOrReceived: number;
  percent: number;
  speed: number; // in Bytes per second
  eta: number; // in seconds
  status: TransferState;
  connectionType?: "Direct" | "Relayed";
}

export interface SignalingMessage {
  type: string;
  senderPeerId?: string;
  targetPeerId?: string;
  payload?: any;
}
