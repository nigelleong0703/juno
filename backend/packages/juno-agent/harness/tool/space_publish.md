---
id: tool.space_publish
placement: T
vars: []
---
Publish an app you built in /workspace/spaces/<slug> (see the spaces skill) so the user can open it from the chat. Call it with the app folder: the first call allocates the port the app must listen on (127.0.0.1) and writes it to <folder>/.juno-port; start the app on that port as a background process, then call space_publish again with the same folder to wire it up and post the app card. Calling it again later with the same folder updates the title. Pass spaceId only to name an app you already published.
