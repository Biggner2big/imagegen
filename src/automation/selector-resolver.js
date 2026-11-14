'use strict';

const { SelectorNotFoundError } = require('./errors');

/**
 * Resolves a named selector key to the first configured selector whose target
 * exists (and is visible) on the page. Selector chains live exclusively in
 * config/selectors.json (R10); no DOM selectors are hardcoded in automation
 * code.
 *
 * Page evaluation always goes through the `__gbs` helper installed by
 * GeminiAdapter, which understands the `:has-text("...")` pseudo selector used
 * in the config file.
 */
class SelectorResolver {
  constructor(selectors, logger) {
    this.selectors = selectors || {};
    this.logger = logger || null;
    this.cache = new Map();
  }

  chain(key) {
    const chain = this.selectors[key];
    if (!Array.isArray(chain) || chain.length === 0) {
      throw new SelectorNotFoundError(key, []);
    }
    return chain;
  }

  async find(exec, key, options = {}) {
    const chain = this.chain(key);
    const cached = this.cache.get(key);
    if (cached && options.useCache !== false) {
      const stillThere = await exec(`__gbs.existsByChain(${JSON.stringify([cached])}, ${JSON.stringify({ enabled: !!options.enabled })})`);
      if (stillThere) return cached;
      this.cache.delete(key);
    }

    for (const selector of chain) {
      const found = await exec(`__gbs.existsByChain(${JSON.stringify([selector])}, ${JSON.stringify({ enabled: !!options.enabled })})`);
      if (found) {
        this.cache.set(key, selector);
        return selector;
      }
    }

    if (this.logger) this.logger.warn({ key, chain }, 'selector chain not found');
    throw new SelectorNotFoundError(key, chain);
  }

  async findOptional(exec, key, options = {}) {
    try {
      return await this.find(exec, key, options);
    } catch (err) {
      return null;
    }
  }

  async probeAll(exec) {
    const results = [];
    for (const key of Object.keys(this.selectors)) {
      if (key.startsWith('_')) continue;
      const chain = this.selectors[key];
      if (!Array.isArray(chain)) continue;

      let matched = null;
      for (const selector of chain) {
        try {
          const found = await exec(`__gbs.existsByChain(${JSON.stringify([selector])})`);
          if (found) { matched = selector; break; }
        } catch (err) {
          // Invalid selector in the chain: keep trying the rest.
        }
      }
      results.push({ key, found: !!matched, selector: matched || '' });
    }
    return results;
  }

  clearCache() {
    this.cache.clear();
  }
}

module.exports = { SelectorResolver };
