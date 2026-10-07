# Frontier Link

Frontier Link is the Windows helper for Frontier Guide 1.7.5. It pairs with the phone by a 6-digit code or a `frontier-link://` link, then sits in the system tray.

Capture is off until you turn on **Capture the Red Dead Redemption 2 window**. While that switch is on, the helper copies only that window, about once every four seconds, and sends the frame to your paired Frontier Guide so Live Coach can use it instead of the phone camera. Windows OCR reads pickup text on this PC. A line that names a collectible, such as the White Arabian, can mark that pin. A generic "Gold Bar" asks you which pin it was. A "Challenge complete" line is noted and not turned into a pin.

Frontier Link does not read game memory, inject code, or open the game process. Closing the window hides it in the tray. Exit is on the tray menu.

The published file is `FrontierLink-Setup.exe`, a self-contained unsigned build. Steam achievements are on the phone, not in this helper. Those need a Steam Web API key on the server and a public Game details setting on the Steam profile.
