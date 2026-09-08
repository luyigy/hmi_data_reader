// Run with Playwright browser_run_code_unsafe(filename=...) against an isolated lab at 18766.
// Uses real browser clipboard permissions and synthetic image data; no GPU or Web DB.
async (page) => {
  await page.goto('http://127.0.0.1:18766');
  await page.waitForFunction(() => !document.querySelector('#paste').disabled);
  await page.locator('#new').click();
  await page.waitForFunction(() => !document.querySelector('#paste').disabled);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 25;
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
  });
  await page.locator('#paste').click();
  await page.waitForFunction(() => document.querySelectorAll('#photos img').length === 1);
  await page.waitForFunction(() => !document.querySelector('#paste').disabled);
  await page.evaluate(() => navigator.clipboard.writeText('only text'));
  await page.locator('#paste').click();
  await page.waitForFunction(() => document.querySelector('#message').textContent.includes('没有图片'));
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'read', {
    configurable: true, value: async () => { throw new DOMException('denied', 'NotAllowedError'); },
  }));
  await page.locator('#paste').click();
  await page.waitForFunction(() => document.querySelector('#message').textContent.includes('未能读取'));
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 30;
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([blob], 'paste.png', {type: 'image/png'}));
    // Input fields must retain normal paste behavior.
    const inputEvent = new ClipboardEvent('paste', {clipboardData, bubbles: true, cancelable: true});
    document.querySelector('#note').dispatchEvent(inputEvent);
    if (inputEvent.defaultPrevented) throw new Error('Text input paste was intercepted');
    document.querySelector('#paste').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData, bubbles: true, cancelable: true,
    }));
  });
  await page.waitForFunction(() => document.querySelectorAll('#photos img').length === 2);
  await page.setViewportSize({width: 390, height: 844});
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
    throw new Error('Mobile page overflows');
  }
  return 'PASS: clipboard image, empty clipboard, denied permission, paste event, input isolation, mobile width';
}
