'use strict';

const promptsRepo = require('../database/repos/prompts.repo');

/**
 * Thin domain wrapper around prompts.repo so callers do not depend on SQL.
 */
module.exports = {
  list: () => promptsRepo.listPrompts(),
  get: (id) => promptsRepo.getPrompt(id),
  getDefault: () => promptsRepo.getDefaultPrompt(),
  save: (prompt) => promptsRepo.savePrompt(prompt),
  setDefault: (id) => promptsRepo.setDefaultPrompt(id),
  remove: (id) => promptsRepo.deletePrompt(id)
};
