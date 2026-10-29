---
id: tool.browser.act
placement: T
vars: []
---
Direct operations without the browser helper. For known text use action=fill, args={fields:[{ref,text}]} to batch up to12 editable fields. For drafting use action=write, args={facts:string,fields:[{ref,brief}]}; one existing fast-model call drafts text (normal model fallback), then canonical fill. Missing/invalid drafts return without effects; supply exact strings via fill instead. snapshot gets refs; click/type/scroll use args. Rechecks pending completion afterwards. action=abandon requires args.reason, records failure and ends browser work for this run. Normal approval applies; secure input uses its dedicated tools.
