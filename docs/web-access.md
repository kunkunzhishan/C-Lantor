# Tailscale Web Access

Lantor exposes a browser-accessible web UI from the same desktop process so you
can open it from another device, such as a phone over Tailscale. It is enabled
by default on `0.0.0.0:8787`.

```bash
npm run build
npm run tauri:dev
```

Then open the Mac's Tailscale address from the other device:

```text
http://<mac-tailscale-ip>:8787/
```

When `LANTOR_WEB_BIND` is left at its default `0.0.0.0:8787`, generated share
links prefer the Mac's Tailscale `100.x` address when one is available. You can
still override the public base URL with `LANTOR_WEB_PUBLIC_URL`.

Loopback requests from the same Mac can use:

```text
http://127.0.0.1:8787/
```

To restrict to loopback, set `LANTOR_WEB_BIND=127.0.0.1:8787`. To turn the web
server off, set `LANTOR_WEB_BIND=off` (also accepts `none`, `disabled`,
`false`, or `0`).

The web UI does not perform its own token check. Only expose Lantor on a
trusted private network such as your Tailscale tailnet.

The web UI uses HTTP endpoints under `/api/` for the subset of Tauri commands
the chat surface needs, including:

- bootstrap and runtime health checks
- sending messages, creating/updating/deleting channels and agents
- managing channel agent membership and saved messages
- inbox dismissal and read state, channel read state
- reminders (completing) and tasks (status, title, claim)
- cancelling and retrying agent work
- installing and uninstalling the supervisor LaunchAgent
- opening agent DMs
- reading artifacts and attachment preview
- agent workspace listing and file preview
- owner profile updates

Live refresh is delivered over an SSE stream at `/api/events`. Desktop Tauri
still uses native IPC for the same operations.

## Embedded Tool Browser

The Tool Browser is an in-app top-right embedded panel for opening tool output
or browser-display links from message markdown. HTTP and HTTPS links render with
an `内置打开` button next to the link. Clicking that button inserts a resizable
browser panel into the top-right cell of the main app layout. The right-side
detail area below it is pushed down by the panel's actual height, while the main
conversation area keeps its normal height instead of being displaced by a full
width top strip. The embedded frame keeps a standard web viewport ratio
(`16:9`) at a smaller default size, with the panel header added above it.
Drag-resizing preserves that webpage ratio with a modest maximum size. Clicking
the same link button again closes it. Clicking a different link retargets the
same panel.

It accepts only absolute `http://` and `https://` targets with a host, including
loopback targets such as `http://localhost:5173/...`,
`http://127.0.0.1:3000/...`, and `http://[::1]:3000/...`.

The validator rejects relative URLs, hostless URLs, credentials in the URL,
control characters, oversized targets, and non-web schemes such as `file:`,
`data:`, `javascript:`, `asset:`, `tauri:`, and `mailto:`. Rejected targets are
not loaded in the Tool Browser; frontend controls are omitted for links that can
be rejected locally.

The embedded frame is sandboxed and does not receive Lantor's app APIs. Some
third-party sites may still refuse to render inside an iframe; use the panel's
external-open button when a site blocks embedding.

## Supervisor LaunchAgent

The Runtime panel can install a user LaunchAgent at:

```text
~/Library/LaunchAgents/local.lantor.supervisor.plist
```

That lets macOS keep the `--supervisor` process alive via `launchctl`.
Uninstall removes the plist and unloads the service.
