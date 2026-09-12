4. Kernel-Level Sandboxing (Security)
The Problem: If we give these agents access to terminal commands (which is required for autonomous coding), a bad prompt could cause them to delete files or leak environment variables.
The Fix:
We cannot rely purely on prompt instructions like "don't delete files". We need to wrap the execution layer in an OS-level sandbox (like nsjail on Linux). This ensures that even if the AI goes rogue, it is physically restricted to the specific project workspace and cannot access the broader system.