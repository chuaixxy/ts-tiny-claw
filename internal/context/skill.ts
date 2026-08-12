// internal/context/skill.ts
// 对应 Go: internal/context/skill.go
//
// 遍历 .claw/skills/ 目录，寻找各个子目录下的 SKILL.md，并解析其 YAML 前言（Frontmatter）。
// 为了保持引擎的极致轻量，我们不引入复杂的第三方 YAML 解析库，
// 而是手写一个基于字符串切割的轻量级解析器。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

/** Skill 定义了从 SKILL.md 中解析出的标准化技能结构 */
export interface Skill {
  name: string
  description: string
  /** Markdown 正文指令 */
  body: string
}

/** SkillLoader 负责从本地文件系统中加载并解析符合规范的技能模板 */
export class SkillLoader {
  private readonly workDir: string

  constructor(workDir: string) {
    this.workDir = workDir
  }

  /**
   * LoadAll 扫描 .claw/skills 目录，解析所有 SKILL.md，并格式化为字符串准备注入 Context。
   * 如果目录不存在，说明当前工作区没有配置技能，静默返回空串。
   */
  loadAll(): string {
    const skillBaseDir = path.join(this.workDir, ".claw", "skills")

    // 如果目录不存在，说明当前工作区没有配置技能，静默返回
    if (!existsSync(skillBaseDir)) {
      return ""
    }

    const parts: string[] = []
    parts.push("\n### 可用专业技能 (Agent Skills)\n")
    parts.push(
      "以下是你拥有的标准化外挂技能，请在符合 description 描述的场景下严格遵循其正文指令：\n\n",
    )

    // 遍历查找 SKILL.md（对应 Go: filepath.WalkDir）
    let walkErr: unknown
    try {
      for (const skillPath of walkSkillMdFiles(skillBaseDir)) {
        try {
          const content = readFileSync(skillPath, "utf8")
          const skill = parseSkillMD(content)

          // 将解析后的技能按结构注入
          parts.push(`#### 技能名称: ${skill.name}\n`)
          parts.push(`**触发条件**: ${skill.description}\n\n`)
          parts.push("**执行指南**:\n")
          parts.push(skill.body)
          parts.push("\n\n---\n")
        } catch {
          // 对应 Go: if err == nil { ... } —— 单文件读失败则跳过
        }
      }
    } catch (err) {
      walkErr = err
    }

    const result = parts.join("")

    // 对应 Go: if err != nil || skillsBuilder.Len() < 100 { return "" }
    if (walkErr != null || result.length < 100) {
      return ""
    }

    return result
  }
}

/** 工厂：对应 Go 的 NewSkillLoader */
export function createSkillLoader(workDir: string): SkillLoader {
  return new SkillLoader(workDir)
}

/**
 * 递归收集 skillBaseDir 下所有名为 SKILL.md 的文件路径。
 * 对应 Go WalkDir 中 `!d.IsDir() && d.Name() == "SKILL.md"` 的过滤逻辑。
 */
function walkSkillMdFiles(dir: string): string[] {
  const found: string[] = []

  const entries = readdirSync(dir)
  for (const name of entries) {
    const full = path.join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }

    if (st.isDirectory()) {
      found.push(...walkSkillMdFiles(full))
      continue
    }

    // 仅处理名为 SKILL.md 的文件
    if (name === "SKILL.md") {
      found.push(full)
    }
  }

  return found
}

/** parseSkillMD 极简解析带有 YAML Frontmatter 的 Markdown 内容 */
export function parseSkillMD(content: string): Skill {
  const skill: Skill = {
    name: "Unknown Skill",
    description: "No description provided.",
    // 默认将全量内容作为 body
    body: content,
  }

  // 简单解析 YAML Frontmatter (以 --- 包裹)
  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    // 对应 Go: strings.SplitN(content, "---", 3)
    const parts = content.split("---", 3)
    if (parts.length === 3) {
      const frontmatter = parts[1] ?? ""
      skill.body = (parts[2] ?? "").trim()

      // 逐行提取 metadata
      const lines = frontmatter.split("\n")
      for (let line of lines) {
        line = line.trim()
        if (line.startsWith("name:")) {
          skill.name = line.slice("name:".length).trim()
        } else if (line.startsWith("description:")) {
          skill.description = line.slice("description:".length).trim()
        }
      }
    }
  }

  return skill
}
