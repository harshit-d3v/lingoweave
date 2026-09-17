import { expect, test } from '@playwright/test'

test('translates the hard cases, restores, and flips direction', async ({ page }) => {
  await page.goto('/?provider=fake')
  const select = page.locator('lingo-switcher select')

  await select.selectOption('es')
  await expect(page.locator('#stats')).toContainText('units')

  await expect(page.locator('#dropdown li').first()).toHaveText('¤Laptops¤')
  await expect(page.locator('my-card p')).toHaveText('¤This text lives inside an open shadow root.¤')
  await expect(page.locator('input[placeholder]')).toHaveAttribute('placeholder', '¤Search products¤')
  await expect(page.locator('dialog h2')).toHaveText('¤Confirm your order¤')
  await expect(page.locator('fieldset p[translate="no"]')).toHaveText('Acme Corporation')
  await expect(page.locator('fieldset code')).toHaveText('npm install lingoweave')

  await page.click('#add')
  await expect(page.locator('fieldset').first().locator('p').last()).toHaveText(/^¤Injected after load/)

  await select.selectOption('ar')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')

  await select.selectOption('en')
  await expect(page.locator('fieldset').first().locator('p').first()).toHaveText('Welcome to the store.')
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
})
