import type { NotionConversation, NotionCopilotAgent, NotionCopilotSettings, NotionCopilotSettingsView } from "@nova-novel/shared";
import { request } from "./api";
const root = "/api/plugins/notion-copilot";
export const notionCopilot = {
  settings: () => request<NotionCopilotSettingsView>(`${root}/settings`),
  configure: (input: NotionCopilotSettings & { token?: string }) => request<NotionCopilotSettingsView>(`${root}/settings`, { method: "PUT", body: JSON.stringify(input) }),
  agents: () => request<{ agents: NotionCopilotAgent[] }>(`${root}/agents`, { method: "POST", body: "{}" }),
  list: () => request<{ conversations: NotionConversation[] }>(`${root}/conversations`),
  create: () => request<{ conversation: NotionConversation }>(`${root}/conversations`, { method: "POST", body: "{}" }),
  get: (id: string) => request<{ conversation: NotionConversation }>(`${root}/conversations/${encodeURIComponent(id)}`),
  send: (id: string, message: string, requestId: string) => request<{ conversation: NotionConversation }>(`${root}/conversations/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ message, requestId }) }),
  cancel: (id: string) => request<{ conversation: NotionConversation }>(`${root}/conversations/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),
};
