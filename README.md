# MultiView

Watch several sites side by side in one browser tab. Built for video and streams (YouTube, Twitch, Kick and others), and works with most general sites too.

Tested in Brave and Edge (Chromium). It should work in Chrome too, but hasn't been tested there.

## Install

1. Download `multiview-chrome_1_0_0.zip` from [Releases](../../releases) and extract it.
2. Open `chrome://extensions` (or `brave://extensions` / `edge://extensions`).
3. Turn on **Developer mode**, click **Load unpacked**, and select the extracted `multiview-chrome_1_0_0` folder.
4. Click the MultiView toolbar button to open the grid.

## Features

- **Split-tree grid**: up to 16 frames, with up to 4 side by side in any row or column. A layout picker sets up common grids in one click.
- **Send links to a frame**: right-click a link and choose **Open link in MultiView frame**, or **Ctrl+Shift+click** it. The link fills a blank frame, or a new frame is added for it. If no grid is open, one opens.
- **Drag and drop**: move frames with a grip and see a live preview while you drag; Esc cancels. Drag the dividers to resize, and double-click one to make its frames equal.
- **Fullscreen inside the frame**: a site's fullscreen button fills that frame instead of the whole screen. This also works in nested embeds and shadow-DOM players.
- **Zoom**: from 100% to 400% while a frame is fullscreen. Use it to crop blurred sides off vertical videos, or to fill a frame with a stream.
- **Per-frame controls**: an address bar, back, forward and reload, plus volume and mute.
- **One auto-hiding control bar**: you choose which screen edge it sits on.
- **Presets**: save named layouts with their URLs and load them on demand.
- **Session history**: drag a past page onto a blank frame.
- **Stays in the grid**: links that would replace the whole page open inside their own frame instead.
- **Crash recovery**: a frame that crashes shows a reload panel.

## How it works

Many sites refuse to be shown in a frame. MultiView removes the `X-Frame-Options` and `Content-Security-Policy` response headers, but only for frames inside its own grid tab. The rule is removed as soon as that tab closes or navigates away. Everything stays in your browser: nothing is collected or sent anywhere.

## Known limitations

- A page script that navigates away more than 2 seconds after a click can still replace the grid.
- Netflix and other DRM sites are untested.
- Some Vimeo embeds show a "Rights issue" message.

## Development

Unit tests for the layout math:

```
node --test tests/layout.test.mjs
```
