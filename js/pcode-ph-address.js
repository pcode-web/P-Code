/**
 * Searchable Philippine address fields for the OB-GYN patients form.
 * Type to filter City / Municipality / Barangay lists from PSGC.
 */
(function (global) {
  "use strict";

  var PSGC_BASE = "https://psgc.gitlab.io/api";
  var CACHE_KEY = "PCODE_psgc_lgus_v1";
  var MAX_RESULTS = 80;
  var cityByCode = {};
  var munByCode = {};
  var provinceNameByCode = {};
  var barangayCache = {};
  var catalogPromise = null;
  var lastCatalog = { cities: [], municipalities: [] };
  var applying = false;
  var bound = false;
  var combos = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function cityEl() {
    return byId("patient-address-city");
  }

  function munEl() {
    return byId("patient-address-municipality");
  }

  function brgyEl() {
    return byId("patient-address-barangay");
  }

  function sortByName(a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""), "en", {
      sensitivity: "base",
    });
  }

  function labelFor(item, withProvince) {
    var name = String(item && item.name ? item.name : "").trim();
    if (!withProvince) return name;
    var provCode = item && item.provinceCode;
    var prov =
      provCode && provinceNameByCode[provCode]
        ? provinceNameByCode[provCode]
        : !provCode
          ? "NCR"
          : "";
    return prov ? name + " (" + prov + ")" : name;
  }

  function normalize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\bcity of\b/g, "")
      .replace(/\bcity\b/g, "")
      .replace(/[.,]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fieldName(input) {
    if (!input) return "";
    return String(input.dataset.phName || input.value || "").trim();
  }

  function fieldCode(input) {
    if (!input) return "";
    return String(input.dataset.phCode || "").trim();
  }

  function setFieldValue(input, name, code) {
    if (!input) return;
    input.value = name || "";
    if (code && code !== "custom") {
      input.dataset.phCode = code;
      input.dataset.phName = name || "";
    } else if (name) {
      input.dataset.phCode = "custom";
      input.dataset.phName = name;
    } else {
      input.dataset.phCode = "";
      input.dataset.phName = "";
    }
  }

  function ensureList(input) {
    var id = input.id + "-list";
    var list = document.getElementById(id);
    if (list) return list;
    list = document.createElement("div");
    list.id = id;
    list.className = "pcode-ph-combo-list";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    document.body.appendChild(list);
    return list;
  }

  function placeList(input, list) {
    var rect = input.getBoundingClientRect();
    var spaceBelow = global.innerHeight - rect.bottom;
    var maxH = 240;
    list.style.position = "fixed";
    list.style.left = Math.max(8, rect.left) + "px";
    list.style.width = Math.max(rect.width, 180) + "px";
    list.style.zIndex = "12000";
    if (spaceBelow < 160 && rect.top > spaceBelow) {
      list.style.top = "auto";
      list.style.bottom = global.innerHeight - rect.top + 4 + "px";
      list.style.maxHeight = Math.min(maxH, rect.top - 16) + "px";
    } else {
      list.style.bottom = "auto";
      list.style.top = rect.bottom + 4 + "px";
      list.style.maxHeight = Math.min(maxH, Math.max(120, spaceBelow - 16)) + "px";
    }
  }

  function hideList(input) {
    var list = input && ensureList(input);
    if (!list) return;
    list.hidden = true;
    list.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
  }

  function hideAllLists(except) {
    Object.keys(combos).forEach(function (key) {
      var combo = combos[key];
      if (combo && combo.input && combo.input !== except) hideList(combo.input);
    });
  }

  function matchScore(item, query, withProvince) {
    if (!query) return 2;
    var q = normalize(query);
    if (!q) return 2;
    var name = normalize(item.name);
    var label = normalize(labelFor(item, withProvince));
    if (name === q || label === q) return 0;
    if (name.indexOf(q) === 0) return 1;
    if (name.indexOf(q) !== -1) return 2;
    if (label.indexOf(q) !== -1) return 3;
    return 99;
  }

  function findExact(items, query, withProvince) {
    var q = String(query || "").trim();
    if (!q) return null;
    var nq = normalize(q);
    var exact = null;
    for (var i = 0; i < (items || []).length; i++) {
      var item = items[i];
      var name = String(item.name || "").trim();
      var label = labelFor(item, withProvince);
      if (name === q || label === q) return item;
      if (!exact && (normalize(name) === nq || normalize(label) === nq)) exact = item;
    }
    return exact;
  }

  function renderList(combo, query) {
    var input = combo.input;
    var list = ensureList(input);
    var items = (combo.items || [])
      .map(function (item) {
        return { item: item, score: matchScore(item, query, combo.withProvince) };
      })
      .filter(function (row) {
        return row.score < 99;
      })
      .sort(function (a, b) {
        if (a.score !== b.score) return a.score - b.score;
        return sortByName(a.item, b.item);
      })
      .map(function (row) {
        return row.item;
      });
    if (query && items.length > MAX_RESULTS) items = items.slice(0, MAX_RESULTS);
    combo.visible = items;
    combo.activeIndex = items.length ? 0 : -1;
    if (!items.length) {
      list.innerHTML =
        '<div class="pcode-ph-combo-empty">No matching place. Keep typing to save a custom name.</div>';
      list.hidden = false;
      placeList(input, list);
      input.setAttribute("aria-expanded", "true");
      return;
    }
    list.innerHTML = items
      .map(function (item, index) {
        return (
          '<button type="button" class="pcode-ph-combo-option' +
          (index === 0 ? " is-active" : "") +
          '" role="option" data-index="' +
          index +
          '">' +
          escapeHtml(labelFor(item, combo.withProvince)) +
          "</button>"
        );
      })
      .join("");
    list.hidden = false;
    placeList(input, list);
    input.setAttribute("aria-expanded", "true");
  }

  function setActiveOption(combo, index) {
    var list = ensureList(combo.input);
    var options = list.querySelectorAll(".pcode-ph-combo-option");
    if (!options.length) return;
    if (index < 0) index = options.length - 1;
    if (index >= options.length) index = 0;
    combo.activeIndex = index;
    options.forEach(function (btn, i) {
      btn.classList.toggle("is-active", i === index);
    });
    if (options[index] && options[index].scrollIntoView) {
      options[index].scrollIntoView({ block: "nearest" });
    }
  }

  function pickItem(combo, item, silent) {
    setFieldValue(combo.input, item ? item.name : "", item ? item.code : "");
    hideList(combo.input);
    if (!silent && typeof combo.onChange === "function") combo.onChange();
  }

  function commitTyped(combo) {
    var typed = String(combo.input.value || "").trim();
    var match = findExact(combo.items, typed, combo.withProvince);
    if (match) {
      pickItem(combo, match, false);
      return;
    }
    setFieldValue(combo.input, typed, typed ? "custom" : "");
    hideList(combo.input);
    if (typeof combo.onChange === "function") combo.onChange();
  }

  function attachCombo(input, options) {
    if (!input) return null;
    if (combos[input.id]) return combos[input.id];
    var combo = {
      input: input,
      items: [],
      withProvince: !!(options && options.withProvince),
      onChange: options && options.onChange,
      visible: [],
      activeIndex: -1,
    };
    combos[input.id] = combo;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    var list = ensureList(input);
    input.setAttribute("aria-controls", list.id);

    input.addEventListener("focus", function () {
      hideAllLists(input);
      if (input.disabled) return;
      if (input.id === "patient-address-municipality" && hasOfficialCity()) {
        hideList(input);
        return;
      }
      if (input.id === "patient-address-city" && hasOfficialMunicipality()) {
        hideList(input);
        return;
      }
      if (input.id === "patient-address-barangay" && !(combo.items && combo.items.length)) {
        var list = ensureList(input);
        list.innerHTML =
          '<div class="pcode-ph-combo-empty">Choose a city or municipality first. Barangays are limited to that place.</div>';
        list.hidden = false;
        placeList(input, list);
        input.setAttribute("aria-expanded", "true");
        return;
      }
      renderList(combo, input.value);
    });
    input.addEventListener("input", function () {
      input.dataset.phCode = "";
      input.dataset.phName = String(input.value || "").trim();
      if (input.disabled) return;
      if (input.id === "patient-address-municipality" && hasOfficialCity()) {
        hideList(input);
        return;
      }
      if (input.id === "patient-address-city" && hasOfficialMunicipality()) {
        hideList(input);
        return;
      }
      renderList(combo, input.value);
    });
    input.addEventListener("keydown", function (event) {
      if (input.disabled) return;
      var listEl = ensureList(input);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (listEl.hidden) renderList(combo, input.value);
        else setActiveOption(combo, combo.activeIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (listEl.hidden) renderList(combo, input.value);
        else setActiveOption(combo, combo.activeIndex - 1);
      } else if (event.key === "Enter") {
        if (!listEl.hidden && combo.activeIndex >= 0 && combo.visible[combo.activeIndex]) {
          event.preventDefault();
          pickItem(combo, combo.visible[combo.activeIndex], false);
        }
      } else if (event.key === "Escape") {
        hideList(input);
      }
    });
    list.addEventListener("mousedown", function (event) {
      var btn = event.target.closest(".pcode-ph-combo-option");
      if (!btn) return;
      event.preventDefault();
      var index = parseInt(btn.getAttribute("data-index"), 10);
      if (combo.visible[index]) pickItem(combo, combo.visible[index], false);
    });
    input.addEventListener("blur", function () {
      setTimeout(function () {
        if (document.activeElement === input) return;
        commitTyped(combo);
      }, 120);
    });
    return combo;
  }

  function setComboItems(input, items, selectedName, placeholder, enabled, withProvince) {
    var combo = combos[input && input.id];
    if (!combo || !input) return;
    combo.items = items || [];
    combo.withProvince = withProvince !== false;
    input.disabled = !enabled;
    input.placeholder = placeholder || "";
    if (!selectedName) {
      setFieldValue(input, "", "");
      return;
    }
    var match = findExact(combo.items, selectedName, combo.withProvince);
    if (match) setFieldValue(input, match.name, match.code);
    else setFieldValue(input, selectedName, "custom");
  }

  function injectStyles() {
    if (document.getElementById("pcode-ph-combo-css")) return;
    var style = document.createElement("style");
    style.id = "pcode-ph-combo-css";
    style.textContent =
      ".pcode-ph-combo-list{overflow:auto;border-radius:0.75rem;border:1px solid rgba(255,255,255,.14);background:rgba(12,10,18,.96);box-shadow:0 16px 40px rgba(0,0,0,.35);padding:0.35rem;}" +
      ".pcode-ph-combo-option{display:block;width:100%;text-align:left;border:0;background:transparent;color:#f8fafc;font-size:0.9rem;line-height:1.35;padding:0.55rem 0.7rem;border-radius:0.55rem;cursor:pointer;}" +
      ".pcode-ph-combo-option:hover,.pcode-ph-combo-option.is-active{background:rgba(167,139,250,.22);}" +
      ".pcode-ph-combo-empty{color:#cbd5e1;font-size:0.8rem;padding:0.65rem 0.7rem;}" +
      "html:not(.dark) .pcode-ph-combo-list,html.pcode-app-bento-root:not(.dark) .pcode-ph-combo-list{background:#fff;border-color:#000;box-shadow:0 10px 28px rgba(15,23,42,.12);}" +
      "html:not(.dark) .pcode-ph-combo-option,html.pcode-app-bento-root:not(.dark) .pcode-ph-combo-option{color:#000;}" +
      "html:not(.dark) .pcode-ph-combo-option:hover,html:not(.dark) .pcode-ph-combo-option.is-active,html.pcode-app-bento-root:not(.dark) .pcode-ph-combo-option:hover,html.pcode-app-bento-root:not(.dark) .pcode-ph-combo-option.is-active{background:#f3e8ff;}" +
      "html:not(.dark) .pcode-ph-combo-empty,html.pcode-app-bento-root:not(.dark) .pcode-ph-combo-empty{color:#475569;}";
    document.head.appendChild(style);
  }

  function fetchJson(url) {
    return fetch(url, { cache: "force-cache" }).then(function (res) {
      if (!res.ok) throw new Error("PSGC request failed");
      return res.json();
    });
  }

  function rememberMaps(payload) {
    provinceNameByCode = payload.provinces || {};
    cityByCode = {};
    munByCode = {};
    (payload.cities || []).forEach(function (item) {
      cityByCode[String(item.code)] = item;
    });
    (payload.municipalities || []).forEach(function (item) {
      munByCode[String(item.code)] = item;
    });
  }

  function loadCatalog() {
    if (catalogPromise) return catalogPromise;
    catalogPromise = Promise.resolve()
      .then(function () {
        try {
          var raw = sessionStorage.getItem(CACHE_KEY);
          if (raw) {
            var cached = JSON.parse(raw);
            if (cached && cached.cities && cached.municipalities && cached.provinces) {
              rememberMaps(cached);
              lastCatalog = cached;
              return cached;
            }
          }
        } catch (_) {}
        return Promise.all([
          fetchJson(PSGC_BASE + "/provinces.json"),
          fetchJson(PSGC_BASE + "/cities.json"),
          fetchJson(PSGC_BASE + "/municipalities.json"),
        ]).then(function (parts) {
          var provinces = {};
          (parts[0] || []).forEach(function (p) {
            if (p && p.code && p.name) provinces[String(p.code)] = p.name;
          });
          var payload = {
            provinces: provinces,
            cities: (parts[1] || []).slice().sort(sortByName),
            municipalities: (parts[2] || []).slice().sort(sortByName),
          };
          rememberMaps(payload);
          lastCatalog = payload;
          try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify(payload));
          } catch (_) {}
          return payload;
        });
      })
      .catch(function (err) {
        catalogPromise = null;
        console.warn("[P-Code] Could not load Philippine address lists", err);
        return { provinces: {}, cities: [], municipalities: [] };
      });
    return catalogPromise;
  }

  function loadBarangays(kind, code) {
    if (!code || code === "custom") return Promise.resolve([]);
    var key = kind + ":" + code;
    if (barangayCache[key]) return Promise.resolve(barangayCache[key]);
    var path =
      kind === "city"
        ? "/cities/" + encodeURIComponent(code) + "/barangays.json"
        : "/municipalities/" + encodeURIComponent(code) + "/barangays.json";
    return fetchJson(PSGC_BASE + path)
      .then(function (rows) {
        var list = (rows || []).filter(function (row) {
          if (!row || !row.name) return false;
          var cityCode = row.cityCode != null ? String(row.cityCode) : "";
          var munCode = row.municipalityCode != null ? String(row.municipalityCode) : "";
          if (kind === "city" && cityCode) return cityCode === String(code);
          if (kind === "municipality" && munCode) return munCode === String(code);
          return true;
        }).slice().sort(sortByName);
        barangayCache[key] = list;
        return list;
      })
      .catch(function (err) {
        console.warn("[P-Code] Could not load barangays", err);
        return [];
      });
  }

  function hasOfficialCity() {
    var code = fieldCode(cityEl());
    return !!(code && code !== "custom");
  }

  function hasOfficialMunicipality() {
    var code = fieldCode(munEl());
    return !!(code && code !== "custom");
  }

  function disableAndClear(input, placeholder) {
    if (!input) return;
    hideList(input);
    input.disabled = true;
    input.placeholder = placeholder || "";
    setFieldValue(input, "", "");
    if (combos[input.id]) combos[input.id].items = [];
  }

  function enableWithItems(input, items, placeholder, withProvince) {
    if (!input) return;
    input.disabled = false;
    input.placeholder = placeholder || "";
    if (combos[input.id]) {
      combos[input.id].items = items || [];
      combos[input.id].withProvince = withProvince !== false;
    }
  }

  function syncExclusiveLgu() {
    if (hasOfficialCity()) {
      disableAndClear(munEl(), "Not used when a city is selected");
    } else {
      enableWithItems(
        munEl(),
        lastCatalog.municipalities || [],
        "Type to search municipality",
        true
      );
    }
    if (hasOfficialMunicipality()) {
      disableAndClear(cityEl(), "Not used when a municipality is selected");
    } else {
      enableWithItems(
        cityEl(),
        lastCatalog.cities || [],
        "Type to search city",
        true
      );
    }
  }

  function parentKind() {
    var cityCode = fieldCode(cityEl());
    var munCode = fieldCode(munEl());
    if (cityCode && cityCode !== "custom") return { kind: "city", code: cityCode };
    if (munCode && munCode !== "custom") return { kind: "municipality", code: munCode };
    return { kind: "", code: "" };
  }

  function refreshBarangays(preferredName) {
    var brgy = brgyEl();
    if (!brgy) return Promise.resolve();
    var parent = parentKind();
    if (!parent.kind) {
      setComboItems(
        brgy,
        [],
        "",
        "Select a city or municipality first",
        false,
        false
      );
      return Promise.resolve();
    }
    setComboItems(brgy, [], preferredName || "", "Loading barangays…", false, false);
    return loadBarangays(parent.kind, parent.code).then(function (list) {
      setComboItems(
        brgy,
        list,
        preferredName || "",
        "Type to search barangay in this " + (parent.kind === "city" ? "city" : "municipality"),
        true,
        false
      );
    });
  }

  function onCityChange() {
    if (applying) return;
    syncExclusiveLgu();
    refreshBarangays("");
  }

  function onMunChange() {
    if (applying) return;
    syncExclusiveLgu();
    refreshBarangays("");
  }

  function bind() {
    injectStyles();
    if (!bound) {
      bound = true;
      attachCombo(cityEl(), { withProvince: true, onChange: onCityChange });
      attachCombo(munEl(), { withProvince: true, onChange: onMunChange });
      attachCombo(brgyEl(), { withProvince: false });
      document.addEventListener("click", function (event) {
        var target = event.target;
        var keep = target && target.closest && (
          target.closest("#patient-address-city") ||
          target.closest("#patient-address-municipality") ||
          target.closest("#patient-address-barangay") ||
          target.closest(".pcode-ph-combo-list")
        );
        if (!keep) hideAllLists();
      });
      global.addEventListener("resize", function () {
        hideAllLists();
      });
    }
    return loadCatalog().then(function (payload) {
      lastCatalog = payload;
      setComboItems(cityEl(), payload.cities || [], fieldName(cityEl()), "Type to search city", true, true);
      setComboItems(
        munEl(),
        payload.municipalities || [],
        fieldName(munEl()),
        "Type to search municipality",
        true,
        true
      );
      syncExclusiveLgu();
      if (!parentKind().kind) {
        setComboItems(brgyEl(), [], "", "Select a city or municipality first", false, false);
      }
      return payload;
    });
  }

  function setFields(patient) {
    var streetEl = byId("patient-address-street");
    var barangay = String(
      (patient && (patient.address_barangay || patient.address_town)) || ""
    ).trim();
    var municipality = String((patient && patient.address_municipality) || "").trim();
    var city = String((patient && patient.address_city) || "").trim();
    var legacy = String((patient && patient.address) || "").trim();
    if (streetEl) {
      var street = String((patient && patient.address_street) || "").trim();
      streetEl.value =
        street || (!barangay && !municipality && !city && legacy ? legacy : "");
    }
    applying = true;
    return bind()
      .then(function (payload) {
        setComboItems(cityEl(), payload.cities || [], city, "Type to search city", true, true);
        setComboItems(
          munEl(),
          payload.municipalities || [],
          municipality,
          "Type to search municipality",
          true,
          true
        );
        syncExclusiveLgu();
        return refreshBarangays(barangay);
      })
      .finally(function () {
        applying = false;
      });
  }

  function collect() {
    return {
      address_city: fieldName(cityEl()),
      address_municipality: fieldName(munEl()),
      address_barangay: fieldName(brgyEl()),
    };
  }

  global.PcodePhAddress = {
    bind: bind,
    setFields: setFields,
    collect: collect,
    selectedName: fieldName,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      bind();
    });
  } else {
    bind();
  }
})(typeof window !== "undefined" ? window : this);
