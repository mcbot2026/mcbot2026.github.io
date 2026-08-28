# mcbot2026.github.io

MergeDemo release console static frontend.

GitHub Pages URLs:

```text
https://mcbot2026.github.io/
https://mcbot2026.github.io/mergedemo-release/
```

The root page is a lightweight tool index. The MergeDemo release console lives in `mergedemo-release/`.

This repository hosts only browser UIs. Build, upload, publish, and recovery commands still run on the packaging machine through the `MergeDemoReleaseTool` API and its local CLI whitelist.

In the page settings dialog, configure:

- API URL: the HTTPS URL that forwards to the packaging-machine ReleaseTool API.
- Token: the local bearer token configured with `MERGEDEMO_RELEASE_API_TOKEN`.

Do not commit API tokens, upload credentials, release state, job logs, or packaging-machine local configuration.
