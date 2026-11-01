/** External notebook conversations carry no novel domain identifiers. */
export interface NotionCopilotSettings { enabled: boolean; apiKeyEnv: string; agentId: string }
export interface NotionCopilotSettingsView extends NotionCopilotSettings {
  hasToken: boolean;
  tokenSource: "session" | "environment" | "none";
  error?: string;
}
export interface NotionCopilotAgent { id: string; name: string; description: string }
export type NotionConversationStatus = "idle" | "running" | "stopping" | "completed" | "requires_action" | "canceled" | "failed" | "interrupted";
export interface NotionCopilotMessage { id: string; role: "user" | "assistant"; text: string; createdAt: string }
export interface NotionConversation {
  id: string;
  title: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  status: NotionConversationStatus;
  messages: NotionCopilotMessage[];
  partialText: string;
  error?: string;
  remoteSessionId?: string;
}
