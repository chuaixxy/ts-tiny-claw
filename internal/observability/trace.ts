// internal/observability/trace.ts
// 对应 Go: internal/observability/trace.go
//
// 定义 Span，以及如何把它塞进 Context（对应 Go context.WithValue）。

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * TraceContext 对应 Go 的 context.Context（本讲起可携带 Span）。
 * - signal：请求取消（对应 Go ctx.Done() / AbortSignal）
 * - span：当前活跃 Span（对应 Go ctx.Value(traceKey{})）
 *
 * 引擎现有 API 仍多使用 AbortSignal；后续接线时可用
 * `{ signal: abortSignal }` 从旧 ctx 升格，或只传 `undefined`。
 */
export type TraceContext = {
  signal?: AbortSignal
  /** 当前活跃 Span，对应 Go 的 traceKey */
  span?: Span
}

/** 将 AbortSignal / TraceContext 归一化为可级联的 TraceContext */
export function asTraceContext(
  ctx: AbortSignal | TraceContext | undefined,
): TraceContext | undefined {
  if (!ctx) return undefined
  if (ctx instanceof AbortSignal) {
    return { signal: ctx }
  }
  return ctx
}

/** 从 TraceContext 取出取消信号，供仍接收 AbortSignal 的下游使用 */
export function signalOf(ctx: TraceContext | undefined): AbortSignal | undefined {
  return ctx?.signal
}

/** Span 代表链路追踪中的一个时间跨度和操作节点 */
export class Span {
  name: string
  startTime: Date
  endTime: Date | null = null
  durationMs = 0
  /** 存放元数据 (如消耗的 Token, 执行的命令) */
  attributes: Record<string, unknown> = {}
  /** 子跨度 */
  children: Span[] = []

  constructor(name: string) {
    this.name = name
    this.startTime = new Date()
  }

  /** EndSpan 结束跨度，计算耗时 */
  endSpan(): void {
    this.endTime = new Date()
    this.durationMs = this.endTime.getTime() - this.startTime.getTime()
  }

  /**
   * AddAttribute 为当前 Span 记录关键的元数据。
   * 对应 Go: s.mu.Lock() —— Node 同步方法无 await 让出，天然互斥。
   */
  addAttribute(key: string, value: unknown): void {
    this.attributes[key] = value
  }

  /** 序列化为与 Go json 标签一致的 snake_case 结构 */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: this.name,
      start_time: this.startTime.toISOString(),
      end_time: (this.endTime ?? new Date(0)).toISOString(),
      duration_ms: this.durationMs,
    }
    if (Object.keys(this.attributes).length > 0) {
      out.attributes = this.attributes
    }
    if (this.children.length > 0) {
      out.children = this.children.map((c) => c.toJSON())
    }
    return out
  }
}

/**
 * StartSpan 开启一个新的追踪跨度，并将其级联到 Context 中。
 * 对应 Go: func StartSpan(ctx context.Context, name string) (context.Context, *Span)
 */
export function startSpan(
  ctx: TraceContext | undefined,
  name: string,
): [TraceContext, Span] {
  const span = new Span(name)

  // 从 context 中尝试获取父 Span
  const parent = ctx?.span
  if (parent) {
    // 对应 Go: parent.mu.Lock() / append Children
    parent.children.push(span)
  }

  // 将当前新创建的 Span 作为最新的父节点，塞入衍生 Context 并返回
  // exactOptionalPropertyTypes：有 signal 才写入，避免显式赋 undefined
  const newCtx: TraceContext = { span }
  if (ctx?.signal) {
    newCtx.signal = ctx.signal
  }
  return [newCtx, span]
}

/**
 * ExportTraceToFile 当整个根 Span 结束时，将其序列化并保存为本地 JSON 文件。
 * 对应 Go: ExportTraceToFile(rootSpan, workDir, sessionID)
 */
export async function exportTraceToFile(
  rootSpan: Span,
  workDir: string,
  sessionID: string,
): Promise<string> {
  const traceDir = path.join(workDir, ".claw", "traces")
  await mkdir(traceDir, { recursive: true })

  const filename = path.join(
    traceDir,
    `trace_${sessionID}_${Math.floor(Date.now() / 1000)}.json`,
  )

  // 美化输出 JSON，便于人类和工具阅读
  const data = JSON.stringify(rootSpan.toJSON(), null, 2) + "\n"
  await writeFile(filename, data, "utf8")
  return filename
}
