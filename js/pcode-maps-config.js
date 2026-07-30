/**
 * Google Maps API key for regular-user nearby care (index.html).
 * Prefer server env PCODE_GOOGLE_MAPS_API_KEY in production; restrict this key by HTTP referrer in Google Cloud Console.
 */
(function (global) {
  'use strict';
  if (!global.PCODE_GOOGLE_MAPS_API_KEY) {
    global.PCODE_GOOGLE_MAPS_API_KEY = 'AIzaSyCIl3LDXufPtpKn7sxZMTN6DywQJokMpA0';
  }
})(typeof window !== 'undefined' ? window : this);
