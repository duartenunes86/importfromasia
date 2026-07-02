# ImportFromAsia Project

## Browser Agent Usage

This project scrapes 1688 and Taobao product pages which contain many large images.
Screenshots of these pages often exceed the Anthropic API's 5MB image limit, causing
`API Error: 400 Could not process image`.

### Rules to avoid image errors

1. **Prefer text snapshots over screenshots.** Use `browser_session_run` with a snapshot/DOM
   command instead of taking a visual screenshot whenever possible.

2. **Use a small viewport when creating sessions.** Always create browser sessions with
   viewport `1024x768` or smaller:
   ```
   viewport: { width: 1024, height: 768 }
   ```

3. **Avoid full-page screenshots of product listing pages** — they contain dozens of product
   images and will always be too large. If you need to inspect a product page visually,
   crop to a specific element or region.

4. **If a screenshot fails with a 400 image error**, fall back to a text snapshot and extract
   the information you need from the DOM/text instead of retrying the screenshot.
