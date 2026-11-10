# Mac app changelog

## 0.3.0

- The Serial console and Board setup are back. The app gives the pages the board's USB serial port through the bridge (`usb.open`, `usb.write`, `usb.close`, `usb.data`, `usb.closed`), as the Android app does: a sheet to choose the board the first time, then POSIX termios at the page's baud (8N1, no flow control), unplug reported to the page. The sandbox gets the serial entitlement and nothing else new. The hello now says platform `macos` and feature `usb`. docs/mac-app.md.

## 0.2.0

- The app shows the console's own pages and the customer site's from the web bundle the iPhone and desktop apps host, in a web view, so it looks the same as the website. The native SwiftUI screens (Overview, Boards, Firmware and the rest) are removed. The bundle is kept on the Mac and refreshed from the console with every file checked, through the iPhone app's code in CraniumKit; sign-in, Touch ID and the Bluetooth update go through the bridge. View menu: Back, Forward, Reload (Developer Tools in Debug).

## 0.1.0

- First version: a native SwiftUI app for the console (team) and the customer site, sharing CraniumKit and the iPhone app models. Builds and passes its tests; the look waits for review. Board setup over serial and account management stay in the web console for now.

- Scheduled deployments and Weekly report pages, and Your listening on the customer side, as the console and customer site pages in a web view. docs/mac-app.md.
