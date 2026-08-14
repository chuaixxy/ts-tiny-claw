// internal/context/recovery.ts
// 对应 Go: internal/context/recovery.go
//
// RecoveryManager 负责在工具执行失败时，根据报错特征分析并注入恢复建议。

/** RecoveryManager 负责在工具执行失败时，根据报错特征分析并注入恢复建议 */
export class RecoveryManager {
  /**
   * AnalyzeAndInject 接收原始报错，匹配已知特征模式，返回增强后的报错信息
   */
  analyzeAndInject(toolName: string, rawError: string): string {
    let hint = ""

    // 我们使用相对稳定的英文系统级报错关键字，或者我们自己手写的工具内部固定报错格式
    const lowerError = rawError.toLowerCase()

    switch (toolName) {
      case "edit_file":
        // 匹配我们在 07 讲中手写的 fuzzyReplace 的固定报错抛出
        if (
          rawError.includes("在文件中未找到 old_text") ||
          rawError.includes("找不到该代码片段")
        ) {
          hint =
            "你提供的 old_text 与文件当前内容不一致，或者缺少必要的缩进。请先使用 `read_file` 工具重新读取该文件，获取最新、准确的内容后，再重新发起编辑。"
        } else if (
          rawError.includes("匹配到了多处") ||
          rawError.includes("提供更多上下文")
        ) {
          hint =
            "你的 old_text 不够具体，命中了多个相同代码块。请在 old_text 中增加上下相邻的几行代码，以确保替换的唯一性。"
        }
        break

      case "read_file":
      case "write_file":
        // 匹配 Node / POSIX 标准错误文案（ENOENT / EACCES）
        if (lowerError.includes("no such file or directory")) {
          hint =
            "路径似乎不正确。请不要凭空猜测，先使用 `bash` 执行 `ls -la` 或 `find . -name` 命令查找正确的目录结构和文件名。"
        } else if (lowerError.includes("permission denied")) {
          hint =
            "你没有权限操作该文件。请检查工作区限制，或者思考是否需要修改其他文件。"
        }
        break

      case "bash":
        if (lowerError.includes("command not found")) {
          hint =
            "系统中未安装该命令。请先思考：是否有替代命令？或者你需要先编写脚本进行安装？"
        } else if (
          rawError.includes("超时") ||
          rawError.includes("DeadlineExceeded")
        ) {
          // 匹配我们手写的 30s timeout 报错
          hint =
            "该命令执行被超时强杀。如果它是一个常驻服务（如 server 或 watch），请将其转入后台执行（例如使用 `nohup ... &`），不要阻塞主线程。"
        } else if (lowerError.includes("syntax error")) {
          hint =
            "Bash 语法错误。请检查引号转义或特殊字符，确保命令在终端中可直接运行。"
        }
        break
    }

    // 如果没有匹配到特定特征，原样返回原始错误；
    // 如果匹配到了，拼接成强有力的、带有浓厚“系统指导意味”的行动指南。
    if (hint === "") {
      return rawError
    }

    return `${rawError}\n\n[系统救援指南]: ${hint}`
  }
}

/** 工厂：对应 Go 的 NewRecoveryManager */
export function createRecoveryManager(): RecoveryManager {
  return new RecoveryManager()
}
