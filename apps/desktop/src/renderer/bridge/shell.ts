// Open a target (path / URL) in the OS default handler, via the Electron main
// process.

export async function open(target: string): Promise<void> {
  await window.api.shell.open(target)
}
