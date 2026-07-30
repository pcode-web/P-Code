/**
 * Regular-user nearby care map — Google Maps + Places Nearby Search.
 */
(function () {
  "use strict";

  var RADIUS_M = 8000;
  var MAX_PLACES = 18;
  var DEFAULT_CENTER = { lat: 14.5995, lng: 120.9842 };

  var map;
  var userMarker;
  var placeMarkers = [];
  var infoWindow;
  var placesService;

  function byId(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, isError) {
    var el = byId("pcode-map-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className =
      "text-sm mt-2 " + (isError ? "text-red-600" : "text-gray-600");
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = ((lat2 - lat1) * Math.PI) / 180;
    var dLng = ((lon2 - lon1) * Math.PI) / 180;
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function isMentalOrCounsellingExclusion(name, types) {
    var n = String(name || "").toLowerCase();
    var t = (types || []).join(" ").toLowerCase();
    if (
      /\bmental hospital\b|\bmental health\b|\bpsychiatr/i.test(n) ||
      /\bpsycholog(y|ist)\b/.test(n) ||
      /counsell?ing/.test(n)
    ) {
      return true;
    }
    if (/psychiatr|psycholog|mental_health/.test(t)) return true;
    return false;
  }

  /** Specialty clinics / orgs that are not OB-GYN / PMOS / women's health focused. */
  var EXCLUDED_SPECIALTY_RE = new RegExp(
    [
      "\\beye\\b",
      "\\beyes\\b",
      "ophthalm",
      "optometr",
      "optic(al|ian)?",
      "vision\\s*center",
      "lasik",
      "\\bdental\\b",
      "\\bdentist",
      "orthodont",
      "\\bderma",
      "skin\\s*clinic",
      "\\bent\\b",
      "otolaryng",
      "ear\\s*nose",
      "\\bnose\\s*(and|&)\\s*throat",
      "orthop(a)?edic",
      "bone\\s*(and|&)\\s*joint",
      "physio",
      "physical\\s*therap",
      "chiropract",
      "veterinary",
      "\\bvet\\b",
      "animal\\s*clinic",
      "pediatric(?!\\s*(gyn|ob))",
      "\\bpaediatric",
      "\\bcardi(o|ac)\\b",
      "heart\\s*center",
      "\\bnephro",
      "\\burolog(?!y\\s*gyn)",
      "\\bneuro(?!gyn)",
      "oncolog(?!y\\s*(gyn|women))",
      "cancer\\s*center",
      "radiolog(y|ist)\\s*only",
      "\\bx-?ray\\s*only",
      "dialysis",
      "rehab(ilitation)?\\s*center",
      "\\bspa\\b",
      "\\baesthetic",
      "cosmetic\\s*surg",
      "plastic\\s*surg",
      "\\bpharmacy\\b",
      "\\bdrugstore\\b",
      "botica",
      "\\bmorgue\\b",
      "funeral",
      "ambulance\\s*only",
      /* Disease-program / specialty-only sites (not general OB-GYN care) */
      "\\btb\\b",
      "\\btubercul",
      "\\bdots\\b",
      "dots\\s*center",
      "\\bhiv\\b",
      "\\baids\\b",
      "\\bcovid",
      "isolation\\s*(ward|unit|center)",
      "quarantine",
      "\\bleprosy\\b",
      "\\bmalaria\\b",
      "\\bdengue\\b",
      "\\baddiction\\b",
      "\\brehab\\b",
      "substance\\s*abuse",
      "\\bdetox\\b",
      "blood\\s*bank"
    ].join("|"),
    "i"
  );

  var WOMEN_HEALTH_RE = new RegExp(
    [
      "gyn(a)?ecol",
      "\\bob[-\\s]?gyn",
      "\\bobgyn",
      "obstetric",
      "women'?s?\\s*health",
      "women'?s?\\s*clinic",
      "maternal",
      "\\bfertility\\b",
      "\\bivf\\b",
      "reproductive",
      "\\bpcos\\b",
      "\\bpmos\\b",
      "polycystic",
      "ultrasound",
      "sonograph",
      "\\bob\\s*ultrasound",
      "pelvic\\s*ultrasound",
      "lying[-\\s]?in",
      "lyingin",
      "maternity",
      "prenatal",
      "antenatal",
      "midwif",
      "birthing",
      "family\\s*planning",
      "endocrin",
      "\\bob\\s*ward",
      "\\bgyn\\b"
    ].join("|"),
    "i"
  );

  var GENERAL_CARE_RE = new RegExp(
    [
      "\\bhospital\\b",
      "medical\\s*center",
      "med\\.?\\s*center",
      "\\bclinic\\b",
      "diagnostic",
      "\\blaboratory\\b",
      "\\blab\\b",
      "medilab",
      "healthcare",
      "health\\s*center",
      "primary\\s*care",
      "general\\s*(hospital|clinic|practice)",
      "\\bmd\\b",
      "\\bdoctor\\b",
      "\\bphysician\\b"
    ].join("|"),
    "i"
  );

  function placeBlob(name, types, vicinity) {
    return (
      String(name || "") +
      " " +
      String(vicinity || "") +
      " " +
      (types || []).join(" ")
    ).toLowerCase();
  }

  function isExcludedSpecialty(name, types, vicinity) {
    if (isMentalOrCounsellingExclusion(name, types)) return true;
    var blob = placeBlob(name, types, vicinity);
    if (EXCLUDED_SPECIALTY_RE.test(blob)) return true;
    var t = (types || []).join(" ").toLowerCase();
    if (
      /veterinary_care|dentist|physiotherapist|spa|beauty_salon|funeral_home|pharmacy/.test(
        t
      )
    ) {
      return true;
    }
    return false;
  }

  function isWomenHealthRelevant(name, types, vicinity) {
    return WOMEN_HEALTH_RE.test(placeBlob(name, types, vicinity));
  }

  function isGeneralCareFacility(name, types, vicinity) {
    var blob = placeBlob(name, types, vicinity);
    var t = (types || []).join(" ").toLowerCase();
    if (types.indexOf("hospital") >= 0) return true;
    if (/hospital|medical_clinic|doctor|health/.test(t) && GENERAL_CARE_RE.test(blob)) {
      return true;
    }
    if (GENERAL_CARE_RE.test(blob)) return true;
    return false;
  }

  /**
   * Keep: OB-GYN / women's health / ultrasound / fertility / general hospitals & clinics.
   * Drop: eye, dental, and other specialty-only centers unrelated to PMOS screening.
   */
  function isRelevantForPmosCare(name, types, vicinity) {
    // Specialty-only names (TB DOTS, dental, eye, etc.) always drop —
    // even when Google tags the place as "hospital".
    if (isExcludedSpecialty(name, types, vicinity)) return false;
    if (isWomenHealthRelevant(name, types, vicinity)) return true;
    // Full general hospitals / medical centers usually include OB-GYN services.
    if (types.indexOf("hospital") >= 0) return true;
    if (isGeneralCareFacility(name, types, vicinity)) return true;
    return false;
  }

  function relevanceScore(name, types, vicinity, km) {
    var score = 0;
    if (isWomenHealthRelevant(name, types, vicinity)) score += 100;
    if (types.indexOf("hospital") >= 0) score += 40;
    if (types.indexOf("doctor") >= 0) score += 15;
    if (/ultrasound|diagnostic|laboratory|medilab/i.test(placeBlob(name, types, vicinity))) {
      score += 25;
    }
    score -= Math.min(40, (km || 0) * 2);
    return score;
  }

  function clearPlaceMarkers() {
    placeMarkers.forEach(function (m) {
      m.setMap(null);
    });
    placeMarkers = [];
  }

  function loadGoogleMaps(apiKey) {
    return new Promise(function (resolve, reject) {
      if (
        window.google &&
        window.google.maps &&
        window.google.maps.places
      ) {
        resolve(window.google.maps);
        return;
      }
      if (!apiKey) {
        reject(new Error("Google Maps API key is missing."));
        return;
      }
      var cbName = "__pcodeGoogleMapsReady";
      window[cbName] = function () {
        try {
          delete window[cbName];
        } catch (_) {}
        if (window.google && window.google.maps) {
          resolve(window.google.maps);
        } else {
          reject(new Error("Google Maps loaded without maps namespace."));
        }
      };
      var s = document.createElement("script");
      s.async = true;
      s.defer = true;
      s.src =
        "https://maps.googleapis.com/maps/api/js?key=" +
        encodeURIComponent(apiKey) +
        "&libraries=places&callback=" +
        cbName;
      s.onerror = function () {
        reject(new Error("Google Maps script failed to load."));
      };
      document.head.appendChild(s);
    });
  }

  function nearbySearchPromise(request) {
    return new Promise(function (resolve) {
      if (!placesService) {
        resolve([]);
        return;
      }
      placesService.nearbySearch(request, function (results, status) {
        if (
          status === google.maps.places.PlacesServiceStatus.OK &&
          results &&
          results.length
        ) {
          resolve(results);
        } else if (
          status === google.maps.places.PlacesServiceStatus.ZERO_RESULTS
        ) {
          resolve([]);
        } else {
          resolve([]);
        }
      });
    });
  }

  function normalizeResults(results, userLat, userLon) {
    var out = [];
    var seen = Object.create(null);

    (results || []).forEach(function (r) {
      if (!r || !r.geometry || !r.geometry.location) return;
      var lat = r.geometry.location.lat();
      var lon = r.geometry.location.lng();
      var name = r.name || "Unnamed facility";
      var types = r.types || [];
      var vicinity = r.vicinity || r.formatted_address || "";

      if (!isRelevantForPmosCare(name, types, vicinity)) return;

      var placeId = r.place_id || "";
      var k =
        placeId ||
        Math.round(lat * 500) / 500 + "|" + Math.round(lon * 500) / 500;
      if (seen[k]) return;
      seen[k] = 1;

      var kind = "clinic";
      if (isWomenHealthRelevant(name, types, vicinity)) kind = "womens_health";
      else if (types.indexOf("hospital") >= 0) kind = "hospital";
      else if (types.indexOf("doctor") >= 0) kind = "doctor";
      else if (
        /ultrasound|diagnostic|laboratory|medilab|sonograph/i.test(
          placeBlob(name, types, vicinity)
        )
      ) {
        kind = "diagnostic";
      } else if (types.indexOf("health") >= 0 || types.indexOf("medical_clinic") >= 0) {
        kind = "clinic";
      }

      var km = haversineKm(userLat, userLon, lat, lon);
      out.push({
        name: name,
        kind: kind,
        lat: lat,
        lon: lon,
        placeId: placeId,
        phone: "",
        website: "",
        mapsUrl: "",
        _km: km,
        _score: relevanceScore(name, types, vicinity, km),
        vicinity: vicinity
      });
    });

    out.sort(function (a, b) {
      if (b._score !== a._score) return b._score - a._score;
      return a._km - b._km;
    });
    return out.slice(0, MAX_PLACES);
  }

  function placeDetailsPromise(placeId) {
    return new Promise(function (resolve) {
      if (!placesService || !placeId) {
        resolve(null);
        return;
      }
      placesService.getDetails(
        {
          placeId: placeId,
          fields: [
            "formatted_phone_number",
            "international_phone_number",
            "website",
            "url",
            "formatted_address"
          ]
        },
        function (place, status) {
          if (
            status === google.maps.places.PlacesServiceStatus.OK &&
            place
          ) {
            resolve(place);
          } else {
            resolve(null);
          }
        }
      );
    });
  }

  /** Nearby Search has no phone — Place Details adds contact fields. */
  function enrichPlacesWithContacts(places) {
    var list = places || [];
    if (!list.length) return Promise.resolve(list);

    return Promise.all(
      list.map(function (p) {
        if (!p.placeId) return Promise.resolve(p);
        return placeDetailsPromise(p.placeId).then(function (d) {
          if (!d) return p;
          p.phone =
            d.formatted_phone_number ||
            d.international_phone_number ||
            "";
          p.website = d.website || "";
          p.mapsUrl = d.url || "";
          if (d.formatted_address && !p.vicinity) {
            p.vicinity = d.formatted_address;
          }
          return p;
        });
      })
    );
  }

  function formatKindLabel(kind) {
    var k = String(kind || "").toLowerCase().replace(/_/g, " ").trim();
    if (k === "womens health" || k === "women's health") return "Women's health / OB-GYN";
    if (k === "hospital") return "Hospital";
    if (k === "doctor") return "Doctor / clinic";
    if (k === "diagnostic") return "Diagnostic / ultrasound";
    if (k === "clinic" || k === "health" || k === "medical clinic") return "Clinic";
    if (k === "point of interest" || k === "establishment") return "Health facility";
    if (!k) return "Health facility";
    return k.replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function placeInfoHtml(p) {
    var title = escapeHtml(p.name || "Facility");
    var line2 = escapeHtml(p.vicinity || formatKindLabel(p.kind));
    var dist =
      p._km != null && isFinite(p._km)
        ? '<div style="margin-top:4px;font-size:12px;color:#475569;">≈ ' +
          p._km.toFixed(1) +
          " km away</div>"
        : "";
    var phone = "";
    if (p.phone) {
      var tel = String(p.phone).replace(/[^\d+]/g, "");
      phone =
        '<div style="margin-top:6px;font-weight:500;font-size:12px;">' +
        '<a href="tel:' +
        escapeHtml(tel) +
        '" style="color:#4f46e5;text-decoration:none;">' +
        escapeHtml(p.phone) +
        "</a></div>";
    }
    var web = "";
    if (p.website) {
      web =
        '<div style="margin-top:4px;font-weight:500;font-size:12px;">' +
        '<a href="' +
        escapeHtml(p.website) +
        '" target="_blank" rel="noopener noreferrer" style="color:#4f46e5;text-decoration:none;">Website</a></div>';
    }
    return (
      '<div class="pcode-maps-iw" style="color:#0f172a;font:600 13px/1.35 system-ui,sans-serif;max-width:240px;">' +
      "<div>" +
      title +
      "</div>" +
      '<div style="margin-top:4px;font-weight:500;font-size:12px;color:#334155;">' +
      line2 +
      "</div>" +
      dist +
      phone +
      web +
      "</div>"
    );
  }

  function renderList(places, onPick) {
    var ul = byId("pcode-nearby-list");
    if (!ul) return;
    ul.innerHTML = "";

    if (!places || !places.length) {
      var li0 = document.createElement("li");
      li0.className = "text-sm text-gray-500 px-1 py-2";
      li0.textContent = "No facilities found in this area.";
      ul.appendChild(li0);
      return;
    }

    places.forEach(function (p, idx) {
      var li = document.createElement("li");
      li.className =
        "text-sm border-b border-gray-100 last:border-0 py-2 px-1 cursor-pointer hover:bg-indigo-50/50 rounded";

      var name = document.createElement("div");
      name.className = "font-semibold text-gray-800";
      name.textContent = idx + 1 + ". " + (p.name || "Unnamed");
      li.appendChild(name);

      if (p.vicinity) {
        var v = document.createElement("div");
        v.className = "text-gray-600 text-xs mt-0.5";
        v.textContent = p.vicinity;
        li.appendChild(v);
      }

      var d = document.createElement("div");
      d.className = "text-gray-500 text-xs mt-0.5";
      d.textContent = "≈ " + p._km.toFixed(1) + " km away";
      li.appendChild(d);

      if (p.kind) {
        var k = document.createElement("div");
        k.className = "text-indigo-600 text-xs mt-0.5";
        k.textContent = formatKindLabel(p.kind);
        li.appendChild(k);
      }

      if (p.phone) {
        var phoneWrap = document.createElement("div");
        phoneWrap.className = "text-xs mt-1";
        var phoneLink = document.createElement("a");
        phoneLink.href = "tel:" + String(p.phone).replace(/[^\d+]/g, "");
        phoneLink.className = "text-indigo-700 font-medium hover:underline";
        phoneLink.textContent = p.phone;
        phoneLink.addEventListener("click", function (e) {
          e.stopPropagation();
        });
        phoneWrap.appendChild(phoneLink);
        li.appendChild(phoneWrap);
      }

      if (p.website) {
        var webWrap = document.createElement("div");
        webWrap.className = "text-xs mt-0.5";
        var webLink = document.createElement("a");
        webLink.href = p.website;
        webLink.target = "_blank";
        webLink.rel = "noopener noreferrer";
        webLink.className = "text-indigo-600 hover:underline";
        webLink.textContent = "Website";
        webLink.addEventListener("click", function (e) {
          e.stopPropagation();
        });
        webWrap.appendChild(webLink);
        li.appendChild(webWrap);
      }

      li.addEventListener("click", function () {
        onPick(idx);
      });

      ul.appendChild(li);
    });
  }

  function showPlaces(places) {
    clearPlaceMarkers();
    if (!map) return;

    var bounds = new google.maps.LatLngBounds();
    if (userMarker) {
      bounds.extend(userMarker.getPosition());
    }

    places.forEach(function (p, idx) {
      var pos = { lat: p.lat, lng: p.lon };
      var marker = new google.maps.Marker({
        map: map,
        position: pos,
        title: p.name || "Facility",
        label: String(idx + 1)
      });
      marker.addListener("click", function () {
        if (!infoWindow) return;
        infoWindow.setContent(placeInfoHtml(p));
        infoWindow.open({ map: map, anchor: marker });
      });
      placeMarkers.push(marker);
      bounds.extend(pos);
    });

    if (places.length) {
      try {
        map.fitBounds(bounds, 48);
      } catch (_) {}
    }
  }

  function searchNearby(lat, lon) {
    setStatus("Searching nearby OB-GYN, women's health, and ultrasound / diagnostic care…");
    var loc = new google.maps.LatLng(lat, lon);

    return Promise.all([
      nearbySearchPromise({
        location: loc,
        radius: RADIUS_M,
        type: "hospital"
      }),
      nearbySearchPromise({
        location: loc,
        radius: RADIUS_M,
        keyword: "gynecology obstetrics OBGYN women's health"
      }),
      nearbySearchPromise({
        location: loc,
        radius: RADIUS_M,
        keyword: "ultrasound diagnostic laboratory fertility maternity"
      }),
      nearbySearchPromise({
        location: loc,
        radius: RADIUS_M,
        type: "doctor",
        keyword: "gynecologist obstetrician women's clinic"
      })
    ]).then(function (batches) {
      var merged = [];
      batches.forEach(function (batch) {
        merged = merged.concat(batch || []);
      });
      var places = normalizeResults(merged, lat, lon);
      setStatus(
        "Loading contact details for " + places.length + " place(s)…"
      );
      return enrichPlacesWithContacts(places);
    });
  }

  function afterLocate(lat, lon) {
    searchNearby(lat, lon)
      .then(function (places) {
        if (!places.length) {
          setStatus(
            "No OB-GYN, women's health, or ultrasound / diagnostic places found near you. Try updating your location.",
            false
          );
          renderList([], function () {});
          showPlaces([]);
          return;
        }
        setStatus(
          "Showing " +
            places.length +
            " place(s) focused on OB-GYN, women's health, hospitals, and diagnostic / ultrasound care."
        );
        showPlaces(places);
        renderList(places, function (idx) {
          var p = places[idx];
          if (!p || !map) return;
          map.panTo({ lat: p.lat, lng: p.lon });
          map.setZoom(16);
          var mk = placeMarkers[idx];
          if (mk && infoWindow) {
            google.maps.event.trigger(mk, "click");
          }
        });
      })
      .catch(function (e) {
        setStatus(
          (e && e.message) ||
            "Could not load nearby places from Google Maps.",
          true
        );
        renderList([], function () {});
      });
  }

  function tryLocate() {
    if (!map) return;
    if (!navigator.geolocation) {
      setStatus("This browser does not support geolocation.", true);
      return;
    }

    setStatus("Detecting your location…");
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        var lat = pos.coords.latitude;
        var lon = pos.coords.longitude;
        var posLatLng = { lat: lat, lng: lon };

        if (userMarker) {
          userMarker.setMap(null);
        }
        userMarker = new google.maps.Marker({
          map: map,
          position: posLatLng,
          title: "You are here",
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: "#6366f1",
            fillOpacity: 0.95,
            strokeColor: "#4f46e5",
            strokeWeight: 2
          }
        });
        if (infoWindow) {
          infoWindow.setContent(
            '<div class="pcode-maps-iw" style="color:#0f172a;font:600 13px/1.35 system-ui,sans-serif;">You are here (approximate)</div>'
          );
          infoWindow.open({ map: map, anchor: userMarker });
        }

        map.setCenter(posLatLng);
        map.setZoom(13);
        afterLocate(lat, lon);
      },
      function (err) {
        var msg = "Location denied or unavailable. ";
        if (err && err.code === 1) {
          msg += "Allow location and try again.";
        } else {
          msg += "Try again.";
        }
        setStatus(msg, true);
      },
      { enableHighAccuracy: true, maximumAge: 300000, timeout: 20000 }
    );
  }

  function bootMap() {
    var el = byId("pcode-nearby-map");
    if (!el) return;

    map = new google.maps.Map(el, {
      center: DEFAULT_CENTER,
      zoom: 12,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true
    });
    infoWindow = new google.maps.InfoWindow();
    placesService = new google.maps.places.PlacesService(map);

    var btn = byId("pcode-nearby-refresh");
    if (btn) {
      btn.addEventListener("click", function () {
        tryLocate();
      });
    }

    if (typeof ResizeObserver !== "undefined") {
      try {
        var ro = new ResizeObserver(function () {
          if (map) {
            google.maps.event.trigger(map, "resize");
          }
        });
        ro.observe(el);
      } catch (_) {}
    }

    window.addEventListener("resize", function () {
      if (map) google.maps.event.trigger(map, "resize");
    });

    tryLocate();
  }

  function boot() {
    var apiKey =
      (window.PCODE_GOOGLE_MAPS_API_KEY || "").trim() ||
      "";
    if (!apiKey) {
      setStatus("Google Maps API key is not configured.", true);
      return;
    }

    setStatus("Loading Google Maps…");
    loadGoogleMaps(apiKey)
      .then(function () {
        bootMap();
      })
      .catch(function (e) {
        setStatus(
          (e && e.message) ||
            "Google Maps failed to load. Check the API key and enabled APIs.",
          true
        );
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
