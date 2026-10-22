# dsh-ai-memory

**Mnemosyne OS 8.1.0 记忆能力 × DeepSeek Harness —— 自动注册、自动记忆、自动召回。**

一条命令 + 浏览器点一次授权，DSH 会话即可跨重启记住事情。52 个 MCP 工具全部可用，
不需要写一行胶水代码。

---

## 安装（30 秒）

```bash
dsh plugin add github:MnemosyneOS/mnemosyne-dsh
dsh-ai-memory-login
```

然后重启 `dsh web`。完事。

> 需要 Node 18+ 与 [pnpm](https://pnpm.io)（`dsh plugin` 底层调 pnpm，找不到会报
> `dsh: pnpm was not found; install pnpm and make it available on PATH.`）。

## 首次授权（Device Flow）

`dsh-ai-memory-login` 会打印一个短链：

```
请在浏览器打开下面这个地址完成授权：

    https://ai-memory.net/api/device/confirm?code=ABCD2345
```

打开、登录、点「授权」。随后本命令会：

1. 拿到一把只属于**你的** `mn-` 密钥（已绑定你的命名空间）；
2. 往 profile 的 `cordis.patch.yml` 里**只写一行** `Authorization: Bearer mn-…`；
3. 写之前先备份成 `.bak-dsh-ai-memory`；
4. 其余字节一律不动 —— 你的注释和其他 MCP 服务器保持原样。

密钥在终端里只显示前后 4 位（`mn-Abcd****wxyz`），不会进日志。

## 它到底做了什么

注册一个 MCP 服务器（`mnemosyne`，streamable HTTP，`https://ai-memory.net/v1/mcp`），
把 Mnemosyne OS 的完整工具面交给 DSH。常用的几个：

| 工具 | 作用 |
|---|---|
| `retain` / `retain_batch` | 写入记忆（内容/类型/标签/置信度/重要性），批量约 15 倍加速 |
| `recall` | 五路召回，可设 token 预算与压缩 |
| `forget` | 软遗忘：置信度降 0 并标记 deleted，仍可回溯 |
| `capsule` / `expand` | 压成指针+事实原子；按指针取回原文并校验内容哈希 |
| `recall_catalog` / `expand_memory` | 渐进披露：先看目录，再取全文 |
| `graph_query` / `temporal_query` | 沿知识图谱走 N 跳；按时间返回版本链 |
| `memory_inject` / `profile_card` | 五步注入流水线 / 三段画像卡，可直接拼进 system prompt |
| `session_summarize` / `topic_summarize` | 会话摘要七要素；项目级状态合成 |
| `conflict_resolve` | 六类冲突判定 + 四操作 |
| `code_change_record` / `code_archaeology` | 记录代码变更的意图、约束、放弃的方案；代码考古与坑位预警 |

然后在任意会话里说"记住：我叫张三，乳糖不耐"；新开会话问"我喝咖啡要注意什么"，
它能答出来。

## 隐私与数据

- **数据存在哪。** 你在 ai-memory.net 上属于自己的命名空间，按账号物理隔离。
- **隔离由服务端决定。** 命名空间由服务端按登录会话判定（管理员 `default`，成员
  `u_<sha256(email)[:16]>`）；客户端传的命名空间一律忽略。别人的密钥看不到你的记忆。
- **密钥。** 库里只存 SHA-256 摘要，明文只在签发那一刻出现一次。可在 ai-memory.net
  控制台吊销或重新生成。
- **删除与注销。** `dsh plugin remove dsh-ai-memory` 卸插件；`dsh-ai-memory-login --remove`
  摘掉 profile 条目；在控制台删除命名空间即清空已存记忆。本地配置文件始终是你的：
  登录器只改一行、必留 `.bak-dsh-ai-memory` 备份、自检不过立即回滚。
- **无遥测。** 插件只与 ai-memory.net 通信（device flow + MCP），不接第三方。

## 卸载

```bash
dsh-ai-memory-login --remove          # 从 profile 摘掉 MCP 条目
dsh plugin remove dsh-ai-memory       # 卸载包
```

重启 `dsh web`。

## 选项

```
--profile <name>   目标 DSH profile（默认 web）
--file <path>      直接指定 cordis.patch.yml 路径
--base-url <url>   覆盖服务端地址（默认 https://ai-memory.net）
--no-browser       不自动打开浏览器
--remove           摘掉本插件写入的条目
-h, --help         帮助
```

退出码：`0` 成功或已配置 · `1` 失败 · `2` 用户取消 / 超时。

## 开发

```bash
node test/login.test.mjs   # 26 项检查：协议 + 幂等写入
```

## License

MIT © MnemosyneOS
