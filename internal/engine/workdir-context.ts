// 让工具执行期读取「当前 Session 锁定的工作区」。
// Engine 无状态、不绑 WorkDir；Run 时用 AsyncLocalStorage 把 session.workDir 注入下去。

import { AsyncLocalStorage } from "node:async_hooks"

const storage = new AsyncLocalStorage<string>()

/** 在 session.workDir 上下文中执行（对应 Go 里 Run 使用 session.WorkDir） */
export function runWithWorkDir<T>(workDir: string, fn: () => Promise<T>): Promise<T> {
  return storage.run(workDir, fn)
}

/** 工具侧取活跃工作区；无上下文时回退到工具构造时的 fallback */
export function getActiveWorkDir(fallback: string): string {
  return storage.getStore() ?? fallback
}
