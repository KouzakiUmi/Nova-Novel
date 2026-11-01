/**
 * Notion → Nova Novel 便签单向同步。
 *
 * 设计约束（刻意为之）：
 * - 零侵入：不 import DomainStore，不改 SQLite schema，不触碰既有领域事务。
 *   落库一律走 Novel 自己的 `POST /api/notes`，因此 note.created 事件、
 *   标题/标签校验、场景与元素关联检查全部沿用既有实现。
 * - 去重靠独立 JSON 状态文件。原因：store.createNote 每次调用都 newId("note")，
 *   没有幂等键，重复拉取会产生重复便签（见 store.ts 中 createNote 实现）。
 * - 单向：只读 Notion，不写回。Novel 侧是唯一权威。
 *
 * 用法：
 *   const sync = new NotionNoteSync({ ... });
 *   const result = await sync.sync();
 */

const NOTION_VERSION = "2026-03-11";
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;
const MAX_TITLE_LEN = 200;

/** 同步状态：notion 页面 id → 已落库的便签。 */
interface SyncState {
  [notionPageId: string]: {
    noteId: string;
    lastEditedAt: string;
  };
}

export interface NotionNoteSyncOptions {
  /** Notion Integration Token（ntn_... 或 legacy secret_...）。 */
  readonly token: string;
  /** 目标数据库 id。作者需在该库上 share 此 integration。 */
  readonly databaseId: string;
  /** Nova Novel 服务地址，例如 http://127.0.0.1:43110。 */
  readonly novelBaseUrl: string;
  /** 目标作品 id。 */
  readonly projectId: string;
  /** 去重状态文件路径，建议放在数据目录下。 */
  readonly statePath: string;
  /** 可选：Electron 模式的配对令牌。 */
  readonly novelToken?: string;
  /** 可选：Notion 站点根地址（镜像/反代）。 */
  readonly notionBaseUrl?: string;
}

export interface NotionSyncResult {
  /** 本次新建的便签数。 */
  readonly created: number;
  /** 因未变化而跳过的页面数。 */
  readonly skipped: number;
  /** 页面已在 Notion 侧更新、按策略新增的条目数。 */
  readonly updated: number;
  /** 单条失败但不影响整体的页面数。 */
  readonly failed: number;
  /** 诊断信息，逐条可读。 */
  readonly messages: string[];
}

/** 从 Notion 属性中读出用于便签的字段。 */
interface NoteDraft {
  readonly title: string;
  readonly tags: string[];
  readonly sceneId?: string;
  readonly elementId?: string;
}

export class NotionNoteSync {
  private readonly opts: NotionNoteSyncOptions;

  constructor(opts: NotionNoteSyncOptions) {
    this.opts = opts;
  }

  async sync(): Promise<NotionSyncResult> {
    const state = await this.loadState();
    const pages = await this.queryPages();

    let created = 0;
    let skipped = 0;
    let updated = 0;
    let failed = 0;
    const messages: string[] = [];

    if (pages.length === 0) {
      // 空结果最常见的原因是 integration 没有被 share 到该数据库。
      messages.push(
        "未查询到任何页面。请确认该 Integration 已在目标数据库上通过 Share 授权（这是最常见原因）。",
      );
    }

    for (const page of pages) {
      try {
        const editedAt = page.last_edited_time ?? "";
        const previous = state[page.id];
        if (previous !== undefined && previous.lastEditedAt === editedAt) {
          skipped += 1;
          continue;
        }

        const draft = readDraft(page);
        if (draft === undefined) {
          failed += 1;
          messages.push(`页面 ${page.id}: 缺少标题，已跳过。`);
          continue;
        }

        const body = await this.fetchPageText(page.id);
        const isUpdate = previous !== undefined;
        const finalBody = isUpdate && previous !== undefined
          ? `【更新于 ${editedAt}，原便签 ${previous.noteId} 保留】\n\n${body}`
          : body;

        const noteId = await this.createNote(draft, finalBody);
        state[page.id] = { noteId, lastEditedAt: editedAt };
        if (isUpdate) updated += 1;
        else created += 1;
      } catch (error) {
        failed += 1;
        messages.push(`页面 ${page.id}: ${describeError(error)}`);
      }
    }

    await this.saveState(state);
    return { created, skipped, updated, failed, messages };
  }

  // ---- Notion 读取 ----

  /** 查询数据库页面。先按新版 data source 尝试，失败回退旧版 database 查询。 */
  private async queryPages(): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let cursor: string | undefined;

    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor !== undefined) body["start_cursor"] = cursor;

      const response = await this.notionFetch(
        `/v1/data_sources/${encodeURIComponent(this.opts.databaseId)}/query`,
        body,
      );
      const payload = (await response.json()) as {
        results?: NotionPage[];
        has_more?: boolean;
        next_cursor?: string | null;
      };
      for (const page of payload.results ?? []) pages.push(page);
      cursor = payload.has_more === true && payload.next_cursor ? payload.next_cursor : undefined;
    } while (cursor !== undefined);

    return pages;
  }

  /** 递归读取页面正文，转成纯文本。深度上限防止异常结构导致无限递归。 */
  private async fetchPageText(pageId: string, depth = 0): Promise<string> {
    if (depth > 4) return "";

    const lines: string[] = [];
    let cursor: string | undefined;

    do {
      const query = cursor === undefined ? "" : `?start_cursor=${encodeURIComponent(cursor)}`;
      const response = await this.notionFetch(
        `/v1/blocks/${encodeURIComponent(pageId)}/children${query}`,
        undefined,
        "GET",
      );
      const payload = (await response.json()) as {
        results?: NotionBlock[];
        has_more?: boolean;
        next_cursor?: string | null;
      };

      for (const block of payload.results ?? []) {
        const text = blockText(block);
        if (text.length > 0) lines.push(text);
        if (block.has_children === true) {
          const childText = await this.fetchPageText(block.id, depth + 1);
          if (childText.length > 0) lines.push(childText);
        }
      }

      cursor = payload.has_more === true && payload.next_cursor ? payload.next_cursor : undefined;
    } while (cursor !== undefined);

    return lines.join("\n");
  }

  private async notionFetch(
    path: string,
    body?: Record<string, unknown>,
    method: "GET" | "POST" = "POST",
  ): Promise<Response> {
    const base = this.opts.notionBaseUrl ?? "https://api.notion.com";
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const response = await fetch(`${base}${path}`, init);
    if (!response.ok) {
      const detail = await safeText(response);
      throw new Error(`Notion API ${response.status}: ${truncate(detail, 300)}`);
    }
    return response;
  }

  // ---- Novel 写入 ----

  private async createNote(draft: NoteDraft, body: string): Promise<string> {
    const payload: Record<string, unknown> = {
      projectId: this.opts.projectId,
      title: truncate(draft.title, MAX_TITLE_LEN),
      body,
      tags: draft.tags,
    };
    if (draft.sceneId !== undefined) payload["sceneId"] = draft.sceneId;
    if (draft.elementId !== undefined) payload["elementId"] = draft.elementId;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.novelToken !== undefined) headers["Authorization"] = `Bearer ${this.opts.novelToken}`;

    const response = await fetch(`${this.opts.novelBaseUrl}/api/notes`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = await safeText(response);
      throw new Error(`Novel API ${response.status}: ${truncate(detail, 300)}`);
    }

    const result = (await response.json()) as { note?: { noteId?: string } };
    const noteId = result.note?.noteId;
    if (noteId === undefined || noteId.length === 0) {
      throw new Error("Novel API 未返回 noteId");
    }
    return noteId;
  }

  // ---- 状态文件 ----

  private async loadState(): Promise<SyncState> {
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(this.opts.statePath, "utf8");
      return JSON.parse(raw) as SyncState;
    } catch {
      // 首次运行或文件损坏：从空状态开始，最多产生一次重复，不做破坏性处理。
      return {};
    }
  }

  private async saveState(state: SyncState): Promise<void> {
    const { writeFile, rename, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(this.opts.statePath), { recursive: true });
    const temp = `${this.opts.statePath}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await rename(temp, this.opts.statePath);
  }
}

// ---- 纯函数与类型 ----

interface NotionPage {
  readonly id: string;
  readonly last_edited_time?: string;
  readonly properties?: Record<string, NotionProperty>;
}

interface NotionProperty {
  readonly type?: string;
  readonly title?: ReadonlyArray<{ plain_text?: string }>;
  readonly rich_text?: ReadonlyArray<{ plain_text?: string }>;
  readonly multi_select?: ReadonlyArray<{ name?: string }>;
}

interface NotionBlock {
  readonly id: string;
  readonly type?: string;
  readonly has_children?: boolean;
  readonly paragraph?: { rich_text?: ReadonlyArray<{ plain_text?: string }> };
  readonly heading_1?: { rich_text?: ReadonlyArray<{ plain_text?: string }> };
  readonly heading_2?: { rich_text?: ReadonlyArray<{ plain_text?: string }> };
  readonly heading_3?: { rich_text?: ReadonlyArray<{ plain_text?: string }> };
  readonly bulleted_list_item?: { rich_text?: ReadonlyArray<{ plain_text?: string }> };
  readonly numbered_list_item?: { rich_text?: ReadonlyArray<{ plain_text?: string }> };
  readonly quote?: { rich_text?: ReadonlyArray<{ plain_text?: string }> };
  readonly code?: { rich_text?: ReadonlyArray<{ plain_text?: string }> };
  readonly callout?: { rich_text?: ReadonlyArray<{ plain_text?: string }> };
}

function readDraft(page: NotionPage): NoteDraft | undefined {
  const properties = page.properties ?? {};
  let title = "";
  const tags: string[] = [];
  let sceneId: string | undefined;
  let elementId: string | undefined;

  for (const [name, property] of Object.entries(properties)) {
    const type = property.type;
    if (type === "title") {
      title = joinText(property.title);
    } else if (type === "multi_select") {
      for (const option of property.multi_select ?? []) {
        const label = option.name;
        if (label !== undefined && label.length > 0 && tags.length < MAX_TAGS) {
          tags.push(truncate(label, MAX_TAG_LEN));
        }
      }
    } else if (type === "rich_text") {
      // 约定：属性名含「场景」映射 sceneId，含「元素」映射 elementId。
      const value = joinText(property.rich_text).trim();
      if (value.length === 0) continue;
      if (name.includes("场景")) sceneId = value;
      else if (name.includes("元素")) elementId = value;
    }
  }

  if (title.trim().length === 0) return undefined;

  const draft: NoteDraft = { title, tags };
  if (sceneId !== undefined) return { ...draft, tags, sceneId, ...(elementId === undefined ? {} : { elementId }) };
  if (elementId !== undefined) return { ...draft, tags, elementId };
  return draft;
}

function joinText(rich: ReadonlyArray<{ plain_text?: string }> | undefined): string {
  if (rich === undefined) return "";
  return rich.map((item) => item.plain_text ?? "").join("");
}

function blockText(block: NotionBlock): string {
  const type = block.type;
  if (type === undefined) return "";
  const container = (block as unknown as Record<string, { rich_text?: ReadonlyArray<{ plain_text?: string }> }>)[type];
  const text = joinText(container?.rich_text);
  if (text.length === 0) return "";
  if (type.startsWith("heading")) return `# ${text}`;
  if (type === "code") return "```\n" + text + "\n```";
  return text;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
