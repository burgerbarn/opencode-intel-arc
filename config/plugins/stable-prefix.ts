// Keeps the system prompt identical across folders and days so llama-server can reuse its prompt cache.
// Moves OpenCode's <env> block (working directory, date) out of the system prompt and into the first user message.
export const StablePrefix = async ({ directory }: { directory: string }) => ({
  "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
    output.system.forEach((s, i) => { output.system[i] = s.replace(/<env>[\s\S]*?<\/env>\s*/g, "") })
  },
  "experimental.chat.messages.transform": async (_input: unknown, output: { messages: any[] }) => {
    const first = output.messages.find((m) => m.info.role === "user")
    const part = first?.parts.find((p: any) => p.type === "text")
    if (!part || part.text.startsWith("<env>")) return
    part.text = `<env>\nWorking directory: ${directory}\nToday's date: ${new Date().toDateString()}\n</env>\n\n${part.text}`
  },
})
