/**
 * Entry point for the standalone `<script>` build.
 *
 * Everything is inlined into one file and hung off `window.lingoweave`, so a
 * plain HTML site with no build step gets the same library an npm consumer does.
 * Those sites are the ones Google's discontinued widget left with nothing.
 */

import { createWeaver, LingoWeave, weave } from './index.js'
import { directionFor, isRtl } from './core/rtl.js'
import * as providers from './providers.js'
import { defineSwitcher, LingoSwitcher } from './switcher.js'

defineSwitcher()

export { createWeaver, defineSwitcher, directionFor, isRtl, LingoSwitcher, LingoWeave, providers, weave }

export default { createWeaver, defineSwitcher, directionFor, isRtl, LingoSwitcher, LingoWeave, providers, weave }
