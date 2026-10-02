/** Validated service-to-service outbound requests. No model or browser identity involved. */
export interface OutboundAutomationMedia {
  mimeType: 'image/jpeg' | 'image/png' | 'application/pdf';
  fileName: string;
  dataBase64: string;
}

export interface OutboundAutomationRequest {
  to: string;
  text: string;
  expiresInSeconds: number;
  media?: OutboundAutomationMedia;
}

export type AutomationEnqueueResult = 'queued' | 'duplicate' | 'conflict' | 'full';

export interface OutboundAutomationStatus {
  messageId: string;
  state: string;
  createdAt: string;
  expiresAt: string;
  finishedAt: string | null;
  reason: string | null;
}

export interface OutboundAutomationService {
  enqueue(
    key: string,
    request: OutboundAutomationRequest,
  ): Promise<{
    messageId: string;
    status: AutomationEnqueueResult;
  }>;
  status(messageId: string): Promise<OutboundAutomationStatus | null>;
}
