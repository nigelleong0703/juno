---
id: tool.connector_search
placement: T
vars: []
---
Search the catalog of apps the user can connect (Gmail, Notion, Outlook, Strava…): each result has an id, name, what it does and whether you can use it (connected), it is turned off for you, its sign-in expired, never finished or lacks a permission (expired, needs_reconnect, scope_missing), or it is available to add. Give need (a capability such as mail.send) to get only the catalog apps that provide it, best first. Use it when a request needs an app you have no tool for, then call connect_request with the ids or with need.
