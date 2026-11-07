# OpenCode notification enrollment

Relay does not install a separate app. The Home Screen PWA is the normal OpenCode site at `OPENCODE_RELAY_PUBLIC_URL`, served through the front door.

## Enable notifications

1. Route the entire public OpenCode hostname through the Relay front door and verify normal OpenCode navigation still works.
2. Install that OpenCode site to the Home Screen where the platform requires an installed web app for Web Push (notably iPhone/iPad).
3. Open `/notifications` on the same public OpenCode origin.
4. If prompted, enter the existing OpenCode password. Relay verifies it against upstream OpenCode and does not persist it; the derived Basic Authorization value remains only in that page's memory.
5. Select **Enable notifications** and grant notification permission.

The page uses OpenCode's root-scoped service worker. If no worker is registered yet it registers `/sw.js`; the front door serves OpenCode's original worker plus Relay's notification handlers.

## Disable notifications

Open `/notifications` on the same browser installation and select **Disable notifications**. Relay removes the matching endpoint/key subscription and the browser unsubscribes locally.

## What a push contains

Notification text is deliberately minimal: only **OpenCode completed** or **OpenCode failed**. The payload does not contain prompts, responses, project/directory names, errors, or session titles.

The payload does contain the exact session URL needed for navigation. A tap accepts only a same-origin URL matching:

```text
/server/<server-key>/session/<session-id>
```

It focuses that exact session if already open; otherwise it reuses a same-origin OpenCode window when possible and navigates it to the session; otherwise it opens the exact session URL.

## iPhone validation

Automated tests verify service-worker routing and click behavior, and a physical iPhone test has confirmed background delivery plus exact-session opening from a notification tap. To validate another deployment with the OpenCode Home Screen app closed:

1. Enable notifications from the OpenCode origin.
2. Complete or fail an OpenCode root-session execution.
3. Receive the generic push.
4. Tap it.
5. Confirm the installed OpenCode PWA opens the originating session rather than a separate Relay surface.
