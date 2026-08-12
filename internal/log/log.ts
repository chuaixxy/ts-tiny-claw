/** 对齐 Go 标准库 log 的默认前缀：2006/01/02 15:04:05 */

function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 对应 Go 的 log.Printf / log.Println */
export function log(...args: unknown[]): void {
  console.log(timestamp(), ...args)
}

/** 对应带 Warning 语义的日志输出 */
export function warn(...args: unknown[]): void {
  console.warn(timestamp(), ...args)
}

/** 对应 Go 的 log.Fatal 风格错误输出（不自动 exit） */
export function error(...args: unknown[]): void {
  console.error(timestamp(), ...args)
}
