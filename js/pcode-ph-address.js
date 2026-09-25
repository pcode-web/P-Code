/**
 * Philippine address dropdowns for the OB-GYN patients form.
 * City / Municipality lists come from PSGC; Barangay options load for the selected LGU.
 */
(function (global) {
  "use strict";

  var PSGC_BASE = "https://psgc.gitlab.io/api";
  var CACHE_KEY = "PCODE_psgc_lgus_v1";
  var cityByCode = {};
  var munByCode = {};
  var provinceNameByCode = {};
  var barangayCache = {};
  var catalogPromise = null;
  var applying = false;
  var bound = false;

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

  function selectedName(select) {
    if (!select) return "";
    var opt = select.selectedOptions && select.selectedOptions[0];
    if (!opt || !String(opt.value || "").trim()) return "";
    return String((opt.dataset && opt.dataset.name) || opt.textContent || "").trim();
  }

  function fillSelect(select, placeholder, items, selectedCode, selectedNameValue, withProvince) {
    if (!select) return;
    var html = '<option value="">' + placeholder + "</option>";
    var matched = false;
    (items || []).forEach(function (item) {
      var code = String(item.code || "");
      var name = String(item.name || "").trim();
      if (!code || !name) return;
      var selected = "";
      if (selectedCode && code === String(selectedCode)) {
        selected = " selected";
        matched = true;
      } else if (
        !selectedCode &&
        selectedNameValue &&
        (name === selectedNameValue ||
          normalize(name) === normalize(selectedNameValue))
      ) {
        selected = " selected";
        matched = true;
      }
      html +=
        '<option value="' +
        code.replace(/"/g, "") +
        '" data-name="' +
        name.replace(/"/g, "&quot;") +
        '"' +
        selected +
        ">" +
        labelFor(item, withProvince !== false).replace(/</g, "") +
        "</option>";
    });
    if (selectedNameValue && !matched) {
      html +=
        '<option value="custom" data-name="' +
        String(selectedNameValue).replace(/"/g, "&quot;") +
        '" selected>' +
        String(selectedNameValue).replace(/</g, "") +
        " (saved)</option>";
    }
    select.innerHTML = html;
  }

  function setBarangayPlaceholder(message, enabled) {
    var select = brgyEl();
    if (!select) return;
    select.innerHTML = '<option value="">' + message + "</option>";
    select.disabled = !enabled;
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
    if (!code || code === "custom") {
      return Promise.resolve([]);
    }
    var key = kind + ":" + code;
    if (barangayCache[key]) return Promise.resolve(barangayCache[key]);
    var path =
      kind === "city"
        ? "/cities/" + encodeURIComponent(code) + "/barangays.json"
        : "/municipalities/" + encodeURIComponent(code) + "/barangays.json";
    return fetchJson(PSGC_BASE + path)
      .then(function (rows) {
        var list = (rows || []).slice().sort(sortByName);
        barangayCache[key] = list;
        return list;
      })
      .catch(function (err) {
        console.warn("[P-Code] Could not load barangays", err);
        return [];
      });
  }

  function refreshBarangays(preferredName) {
    var city = cityEl();
    var mun = munEl();
    var cityCode = city && city.value ? city.value : "";
    var munCode = mun && mun.value ? mun.value : "";
    var kind = cityCode && cityCode !== "custom" ? "city" : munCode && munCode !== "custom" ? "municipality" : "";
    var code = kind === "city" ? cityCode : munCode;
    if (!kind) {
      setBarangayPlaceholder("Select a city or municipality first", false);
      if (preferredName) {
        var select = brgyEl();
        if (select) {
          select.innerHTML =
            '<option value="">Select barangay</option>' +
            '<option value="custom" data-name="' +
            String(preferredName).replace(/"/g, "&quot;") +
            '" selected>' +
            String(preferredName).replace(/</g, "") +
            " (saved)</option>";
          select.disabled = false;
        }
      }
      return Promise.resolve();
    }
    setBarangayPlaceholder("Loading barangays…", false);
    return loadBarangays(kind, code).then(function (list) {
      fillSelect(brgyEl(), "Select barangay", list, "", preferredName || "", false);
      var select = brgyEl();
      if (select) select.disabled = false;
    });
  }

  function onCityChange() {
    if (applying) return;
    var mun = munEl();
    if (mun) mun.value = "";
    refreshBarangays("");
  }

  function onMunChange() {
    if (applying) return;
    var city = cityEl();
    if (city) city.value = "";
    refreshBarangays("");
  }

  function bind() {
    if (bound) return loadCatalog();
    bound = true;
    var city = cityEl();
    var mun = munEl();
    if (city) city.addEventListener("change", onCityChange);
    if (mun) mun.addEventListener("change", onMunChange);
    return loadCatalog().then(function (payload) {
      fillSelect(city, "Select city", payload.cities || [], "", "");
      fillSelect(mun, "Select municipality", payload.municipalities || [], "", "");
      setBarangayPlaceholder("Select a city or municipality first", false);
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
        fillSelect(cityEl(), "Select city", payload.cities || [], "", city);
        fillSelect(
          munEl(),
          "Select municipality",
          payload.municipalities || [],
          "",
          municipality
        );
        if (cityEl() && cityEl().value && cityEl().value !== "custom" && munEl()) {
          munEl().value = "";
        }
        return refreshBarangays(barangay);
      })
      .finally(function () {
        applying = false;
      });
  }

  function collect() {
    return {
      address_city: selectedName(cityEl()),
      address_municipality: selectedName(munEl()),
      address_barangay: selectedName(brgyEl()),
    };
  }

  global.PcodePhAddress = {
    bind: bind,
    setFields: setFields,
    collect: collect,
    selectedName: selectedName,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      bind();
    });
  } else {
    bind();
  }
})(typeof window !== "undefined" ? window : this);
