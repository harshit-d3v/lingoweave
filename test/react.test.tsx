import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { createWeaver, LingoWeave } from '../src/index.js'
import { custom } from '../src/providers/http.js'
import {
  LanguageSwitcher,
  LingoweaveProvider,
  useLingoweave,
} from '../src/react.js'

// A provider that wraps each string in markers so a translated pass is visible.
function fakeProvider(mark = '*') {
  return custom(async (texts) => texts.map((t) => `${mark}${t}${mark}`))
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.body.innerHTML = ''
  document.documentElement.lang = 'en'
  document.documentElement.removeAttribute('dir')
})

describe('LingoweaveProvider', () => {
  it('translates children on mount', async () => {
    document.documentElement.lang = 'en'
    render(
      <LingoweaveProvider to="es" from="en" providers={[fakeProvider()]} cache="memory">
        <p>Welcome</p>
      </LingoweaveProvider>,
    )
    await waitFor(() => {
      expect(document.querySelector('p')?.textContent).toBe('*Welcome*')
    })
  })

  it('useLingoweave().setLanguage switches language', async () => {
    document.documentElement.lang = 'en'
    let api: ReturnType<typeof useLingoweave> | undefined
    function Probe() {
      api = useLingoweave()
      return <p>Welcome</p>
    }
    // start on the source language, so nothing is translated yet
    render(
      <LingoweaveProvider to="en" from="en" providers={[fakeProvider('#')]} cache="memory">
        <Probe />
      </LingoweaveProvider>,
    )
    await waitFor(() => expect(api?.ready).toBe(true))
    expect(document.querySelector('p')?.textContent).toBe('Welcome')

    await act(async () => {
      await api!.setLanguage('es')
    })
    expect(document.querySelector('p')?.textContent).toBe('#Welcome#')
    expect(api!.language).toBe('es')
  })

  it('destroys the weaver on unmount', async () => {
    document.documentElement.lang = 'en'
    const destroy = vi.spyOn(LingoWeave.prototype, 'destroy')
    const { unmount } = render(
      <LingoweaveProvider to="es" from="en" providers={[fakeProvider()]} cache="memory">
        <p>Welcome</p>
      </LingoweaveProvider>,
    )
    await waitFor(() => expect(document.querySelector('p')?.textContent).toBe('*Welcome*'))
    unmount()
    expect(destroy).toHaveBeenCalled()
    destroy.mockRestore()
  })

  it('does not destroy a supplied weaver', async () => {
    const weaver = createWeaver({ to: 'es', from: 'en', providers: [fakeProvider()], cache: 'memory' })
    const spy = vi.spyOn(weaver, 'destroy')
    const { unmount } = render(
      <LingoweaveProvider to="es" weaver={weaver}>
        <p>hi</p>
      </LingoweaveProvider>,
    )
    unmount()
    expect(spy).not.toHaveBeenCalled()
    await weaver.destroy()
  })
})

describe('useLingoweave outside a provider', () => {
  it('throws a clear error', () => {
    function Bad() {
      useLingoweave()
      return null
    }
    // swallow React's error logging for this expected throw
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Bad />)).toThrow(/inside a <LingoweaveProvider>/)
    spy.mockRestore()
  })
})

describe('LanguageSwitcher', () => {
  it('renders the offered languages', async () => {
    document.documentElement.lang = 'en'
    const { container } = render(
      <LingoweaveProvider to="es" from="en" providers={[fakeProvider()]} cache="memory">
        <LanguageSwitcher languages={['en', { code: 'es', label: 'Spanish' }]} />
      </LingoweaveProvider>,
    )
    await waitFor(() => {
      const options = container.querySelectorAll('option')
      expect(options).toHaveLength(2)
      expect(options[1]?.textContent).toBe('Spanish')
    })
  })
})
