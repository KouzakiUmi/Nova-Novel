import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtractedLedgerBundle } from "@nova-novel/shared";
import type { DomainStore } from "./store.js";
import type { CreativeAssistService } from "./assist.js";
import { DomainError } from "./domain.js";

export interface IngestRun {
  runId: string;
  projectId: string;
  title: string;
  status: "running" | "paused" | "review" | "done" | "discarded";
  queue: string[];
  titles: Record<string, string>;
  done: string[];
  failed: { sceneId: string; error: string }[];
  bundles: (ExtractedLedgerBundle & { sceneTitle?: string })[];
  createdAt: string;
  updatedAt: string;
  cancelRequested?: boolean;
}

/** 导入提取运行器：逐场提取、逐场落盘，支持取消、续跑与统一审阅入库；run 以文件持久化。 */
export class IngestRunner {
  private active = new Set<string>();
  constructor(
    private store: DomainStore,
    private assist: CreativeAssistService,
    private dir: string,
    private indexRevision: (projectId: string, revisionId: string, forceSceneIds: ReadonlySet<string>) => void,
  ) { mkdirSync(dir, { recursive: true }); }
  private path(runId: string) { return resolve(this.dir, `${runId}.json`); }
  get(runId: string): IngestRun {
    try { return JSON.parse(readFileSync(this.path(runId), "utf8")) as IngestRun; }
    catch { throw new DomainError(404, "INGEST_RUN_NOT_FOUND", "导入运行不存在或已清理"); }
  }
  private save(run: IngestRun): void { run.updatedAt = new Date().toISOString(); writeFileSync(this.path(run.runId), JSON.stringify(run)); }
  start(projectId: string, title: string): IngestRun {
    const scenes = this.store.listScenes(projectId).filter(scene => scene.body.trim());
    const run: IngestRun = { runId: randomUUID(), projectId, title, status: "running", queue: scenes.map(scene => scene.sceneId), titles: Object.fromEntries(scenes.map(scene => [scene.sceneId, scene.title])), done: [], failed: [], bundles: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.save(run);
    void this.drive(run.runId);
    return run;
  }
  private async drive(runId: string): Promise<void> {
    if (this.active.has(runId)) return;
    this.active.add(runId);
    try {
      for (;;) {
        const run = this.get(runId);
        if (run.status !== "running") break;
        if (run.cancelRequested) { run.status = "paused"; this.save(run); break; }
        const next = run.queue.find(sceneId => !run.done.includes(sceneId) && !run.failed.some(item => item.sceneId === sceneId));
        if (!next) { run.status = "review"; this.save(run); break; }
        try {
          const bundle = await this.assist.extractLedgerFromScene({ projectId: run.projectId, sceneId: next });
          const fresh = this.get(runId);
          fresh.bundles.push({ ...bundle, sceneTitle: fresh.titles[next] ?? next });
          fresh.done.push(next);
          this.save(fresh);
        } catch (cause) {
          const fresh = this.get(runId);
          fresh.failed.push({ sceneId: next, error: cause instanceof Error ? cause.message : "提取失败" });
          this.save(fresh);
        }
      }
    } finally { this.active.delete(runId); }
  }
  cancel(runId: string): IngestRun { const run = this.get(runId); run.cancelRequested = true; this.save(run); return run; }
  resume(runId: string): IngestRun {
    const run = this.get(runId);
    if (run.status === "paused" || run.status === "review") {
      run.status = "running";
      run.cancelRequested = false;
      run.failed = [];
      this.save(run);
      void this.drive(runId);
    }
    return run;
  }
  async commit(runId: string, acceptanceId: string): Promise<{ elements: number; facts: number; events: number }> {
    const run = this.get(runId);
    if (run.status !== "review") throw new DomainError(409, "INGEST_NOT_READY", "还有场景未完成提取，可继续运行或重试失败场景");
    const totals = { elements: 0, facts: 0, events: 0 };
    for (const bundle of run.bundles) {
      const applied = await this.assist.applyExtractedLedger({
        projectId: run.projectId,
        sceneId: bundle.sceneId,
        artifactId: bundle.artifactId,
        selectedProposalIds: [...bundle.newElements, ...bundle.factProposals, ...bundle.eventProposals].map(item => item.proposalId),
        acceptanceId: `${acceptanceId}_${bundle.sceneId}`,
      });
      if (applied.revision) this.indexRevision(run.projectId, applied.revision.revisionId, new Set([bundle.sceneId]));
      totals.elements += applied.entities.length;
      totals.facts += applied.facts.length;
      totals.events += applied.events.length;
    }
    run.status = "done";
    this.save(run);
    return totals;
  }
  discard(runId: string): IngestRun { const run = this.get(runId); run.status = "discarded"; this.save(run); return run; }
}
