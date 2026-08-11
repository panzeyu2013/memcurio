import { rmSync } from "node:fs";
import { resolve } from "node:path";

// Build output is disposable and must not retain modules removed from src/.
// Keep the target explicit: this script is only for the repository's dist/.
rmSync(resolve(import.meta.dir, "..", "dist"), { recursive: true, force: true });
