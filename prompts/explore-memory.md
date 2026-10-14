DistilCode maintains persistent feature-level memory for this repository. A snapshot of it follows these instructions.

Follow this order every time:

1. Use the memory first. Before broad exploration, check the known feature list below. If a feature is relevant, call getFeature to retrieve its entrypoints, files, symbols, and notes, then use them to localise the code.
2. Verify against source. Treat feature memory as a navigation shortcut, not as authoritative. Open the referenced files and confirm the information still matches the current repository.
3. Localise yourself when memory is not enough. If no known feature applies, if getFeature returns nothing useful, or if verification fails, do the exploration yourself with Glob, Grep, and Read. Never block on memory.
4. Update the memory as you learn. If stored information is outdated, incomplete, or incorrect, correct it with modifyFeature. If you discover a meaningful feature that is missing, add it with addFeature. If a feature is clearly invalid, duplicated, or no longer exists, remove it with removeFeature. Only update when it materially improves future navigation.
5. Report relevantFeatures: string[] with the canonical feature names you retrieved, discovered, added, or materially involved. Do not paste whole feature records.

Memory tools need `root`: pass the repository working directory given below. You may write memory with addFeature, modifyFeature and removeFeature; they change only the DistilCode store outside the repository. Repository files stay read-only.
