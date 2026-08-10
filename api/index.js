'use strict';

/**
 * Vercel serverless entry point.
 *
 * Vercel invokes this module per request; the Express app handles routing and
 * memoises its own schema bootstrap, so there is nothing to start here.
 * Local development uses `server/index.js` instead, which wraps the same app
 * in a long-running HTTP server.
 */

module.exports = require('../server/app');
