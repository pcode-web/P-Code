#!/usr/bin/env python3
"""
Lab-style PMOS screening PDF — Python port of _lab_report_template.php + html_to_pdf.py.
Used by the Render Flask /api/export_xai_pdf endpoint (Firebase has no PHP).
"""
from __future__ import annotations

import base64
import html as html_lib
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

try:
    from zoneinfo import ZoneInfo

    _TZ = ZoneInfo("Asia/Manila")
except Exception:  # noqa: BLE001
    _TZ = None

# html_to_pdf lives beside this module
_API_DIR = Path(__file__).resolve().parent
_ROOT = _API_DIR.parent


def _now() -> datetime:
    if _TZ is not None:
        return datetime.now(_TZ)
    return datetime.now()


def _esc(value: Any) -> str:
    return html_lib.escape("" if value is None else str(value), quote=True)


def _empty(as_html: bool = True) -> str:
    return '<span style="color:#888;">—</span>' if as_html else "—"


def _fmt(value: Any, decimals: Optional[int] = None) -> str:
    if value is None or value is False or value == "":
        return _empty()
    try:
        if decimals is not None and str(value).strip() != "" and _is_num(value):
            return f"{float(value):.{decimals}f}"
    except (TypeError, ValueError):
        pass
    return _esc(value)


def _is_num(value: Any) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def _yn(value: Any) -> str:
    if value is None or value == "":
        return _empty()
    if value is True or value == 1 or value == "1" or str(value).lower() == "yes":
        return "Yes"
    if value is False or value == 0 or value == "0" or str(value).lower() == "no":
        return "No"
    return _esc(value)


def _map_dx(raw: Any) -> str:
    if raw is None or raw == "":
        return "Pending"
    if isinstance(raw, (int, float)) or (isinstance(raw, str) and raw.strip().isdigit()):
        try:
            code = int(float(raw))
            if code in (0, 1, 2):
                return {0: "Negative", 1: "Positive", 2: "Borderline"}[code]
        except (TypeError, ValueError):
            pass
    lower = str(raw).strip().lower()
    if lower in ("0", "negative"):
        return "Negative"
    if lower in ("1", "positive"):
        return "Positive"
    if lower in ("2", "borderline"):
        return "Borderline"
    return str(raw).replace("_", " ").capitalize()


def _dx_plain(label: str) -> str:
    lower = str(label).strip().lower()
    if lower == "positive":
        return "Findings suggest a higher likelihood of PMOS. Clinical correlation is required."
    if lower == "negative":
        return "Findings suggest a lower likelihood of PMOS at this time."
    if lower == "borderline":
        return "Findings are inconclusive. Follow-up evaluation is recommended."
    if lower == "pending":
        return "Screening result is not yet available."
    return "Interpret together with clinical history and examination."


def _blood_group(raw: Any) -> str:
    if raw is None or raw == "":
        return _empty()
    s = str(raw).strip()
    if s in ("", "0"):
        return _empty()
    if re.match(r"^(A|B|AB|O)[+-]?$", s, re.I):
        return s.upper()
    mapping = {
        11: "O+",
        12: "O-",
        13: "A+",
        14: "A-",
        15: "B+",
        16: "B-",
        17: "AB+",
        18: "AB-",
        1: "O+",
        2: "O-",
        3: "A+",
        4: "A-",
        5: "B+",
        6: "B-",
        7: "AB+",
        8: "AB-",
    }
    if _is_num(s):
        code = int(round(float(s)))
        if code in mapping:
            return mapping[code]
    return _esc(s)


def _cycle_regularity(raw: Any) -> tuple[str, bool]:
    if raw is None or raw == "":
        return _empty(), False
    s = str(raw).strip()
    if not s:
        return _empty(), False
    if s.lower() == "regular":
        return "Regular", False
    if s.lower() == "irregular":
        return "Irregular", True
    if s.lower() == "amenorrhea":
        return "Amenorrhea", True
    if _is_num(s):
        n = int(round(float(s)))
        if n == 0:
            return "Regular", False
        return "Irregular", True
    return _esc(s), False


def _feature_label(raw: Any) -> str:
    key = str(raw or "").strip()
    mapping = {
        "Age_yrs": "Age",
        "age": "Age",
        "Weight_kg": "Weight",
        "Height_cm": "Height",
        "BMI": "Body Mass Index (BMI)",
        "Blood_Group": "Blood Group",
        "Pulse_rate_bpm": "Pulse Rate",
        "LH_mIU_mL": "LH (Luteinizing Hormone)",
        "FSH_mIU_mL": "FSH (Follicle-Stimulating Hormone)",
        "FSH_LH": "LH/FSH Ratio",
        "LH_FSH_Ratio": "LH/FSH Ratio",
        "AMH_ng_mL": "AMH (Anti-Müllerian Hormone)",
        "PRL_ng_mL": "Prolactin (PRL)",
        "TSH_mIU_L": "TSH (Thyroid-Stimulating Hormone)",
        "Vit_D3_ng_mL": "Vitamin D3",
        "Cycle_length_days": "Menstrual Cycle Length",
        "CycleR_I": "Cycle Regularity",
        "RBS_mg_dl": "Random Blood Sugar (RBS)",
        "Weight_gain": "Unexplained Weight Gain",
        "Hair_growth": "Excess Hair Growth (Hirsutism)",
        "Skin_darkening": "Skin Darkening",
        "Hair_loss": "Hair Loss",
        "Pimples": "Acne / Pimples",
        "Fast_food": "Regular Fast-Food Intake",
        "Reg_Exercise": "Regular Exercise",
    }
    if key in mapping:
        return mapping[key]
    pretty = re.sub(r"_+", " ", key)
    pretty = re.sub(r"\b(mm|cm|kg|ng|mIU|mL|dl)\b", "", pretty, flags=re.I)
    pretty = re.sub(r"\s+", " ", pretty).strip()
    return pretty.title() if pretty else "Clinical Parameter"


def _abnormal_html(text: Any, flag: str = "") -> str:
    safe = text if isinstance(text, str) and "<" in text else _esc(text)
    flag_html = (
        f' <span style="color:#cc0000;font-weight:bold;">{_esc(flag)}</span>' if flag else ""
    )
    return f'<span style="color:#cc0000;font-weight:bold;">{safe}</span>{flag_html}'


def _result_row(
    analyte: str,
    result: Any,
    unit: str = "",
    ref: str = "",
    abnormal: bool = False,
    flag: str = "",
) -> str:
    if abnormal:
        result_html = _abnormal_html(result, flag)
    elif isinstance(result, str) and "<" in result:
        result_html = result
    else:
        result_html = _esc(result) if result not in (None, "") else _empty()
        # result already formatted via _fmt/_pick often includes HTML empty
        if isinstance(result, str) and result.startswith("<"):
            result_html = result
    unit_esc = _esc(unit) if unit else _empty()
    ref_esc = _empty() if ref == "" else (_esc(ref) if "<" not in ref else ref)
    return (
        "<tr>"
        f'<td style="padding:3px 4px;border:none;font-size:10px;width:34%;">{_esc(analyte)}</td>'
        f'<td style="padding:3px 4px;border:none;font-size:10px;width:22%;">{result_html}</td>'
        f'<td style="padding:3px 4px;border:none;font-size:10px;width:16%;">{unit_esc}</td>'
        f'<td style="padding:3px 4px;border:none;font-size:10px;width:28%;">{ref_esc}</td>'
        "</tr>"
    )


def _info_row(label: str, value: Any) -> str:
    if isinstance(value, str) and "<" in value:
        val_html = value
    else:
        val_html = _esc(value)
    return (
        "<tr>"
        f'<td style="padding:3px 4px;border:none;font-size:10px;width:38%;color:#333;">{_esc(label)}</td>'
        f'<td style="padding:3px 4px;border:none;font-size:10px;width:62%;"><strong>{val_html}</strong></td>'
        "</tr>"
    )


def _group_row(title: str, cols: int = 4) -> str:
    return (
        f'<tr class="pcode-group-row"><td colspan="{int(cols)}" class="pcode-group-cell" '
        'style="padding:5px 4px;font-size:10px;font-weight:bold;border-top:0.5px solid #666;'
        'border-bottom:0.5px solid #666;border-left:none;border-right:none;background:transparent;'
        f'letter-spacing:0.2px;">{_esc(title)}</td></tr>'
    )


def _dx_row(label: str, finding: Any, abnormal: bool = False, flag: str = "") -> str:
    if abnormal:
        finding_html = _abnormal_html(finding, flag)
    elif isinstance(finding, str) and "<" in finding:
        finding_html = finding
    else:
        finding_html = _esc(finding)
    return (
        "<tr>"
        f'<td style="padding:3px 4px;border:none;font-size:10px;width:55%;">{_esc(label)}</td>'
        f'<td style="padding:3px 4px;border:none;font-size:10px;width:45%;">{finding_html}</td>'
        "</tr>"
    )


def _ob_final_dx_row(label: str) -> str:
    choices = "[ ] Negative    [ ] Borderline    [ ] Positive"
    return (
        '<tr class="pcode-ob-final-row">'
        f'<td style="padding:5px 4px;border:none;border-top:0.5px solid #999;border-bottom:0.5px solid #999;'
        f'font-size:10px;font-weight:bold;width:55%;background:transparent;">{_esc(label)}</td>'
        f'<td style="padding:5px 4px;border:none;border-top:0.5px solid #999;border-bottom:0.5px solid #999;'
        f'font-size:9px;width:45%;background:transparent;">{_esc(choices)}</td>'
        "</tr>"
    )


def _pick(patient: dict, keys: list, decimals: Optional[int] = None, yn: bool = False) -> str:
    for k in keys:
        if k in patient and patient[k] is not None and patient[k] != "":
            return _yn(patient[k]) if yn else _fmt(patient[k], decimals)
    return _empty()


def _img_src(raw: Any) -> str:
    if not raw or not isinstance(raw, str):
        return ""
    raw = raw.strip()
    if not raw:
        return ""
    if raw.lower().startswith("data:image"):
        return raw
    head = raw[:64]
    if re.match(r"^[A-Za-z0-9+/=\s]+$", head):
        return "data:image/jpeg;base64," + re.sub(r"\s+", "", raw)
    return raw


def _logo_html() -> str:
    resources = _ROOT / "resources"
    for name in ("PCODE_LOGO_pdf.png", "PCODE_LOGO.png"):
        path = resources / name
        if path.is_file():
            b64 = base64.b64encode(path.read_bytes()).decode("ascii")
            return (
                f'<img class="brand-logo" src="data:image/png;base64,{b64}" '
                'alt="P-Code" width="48" height="48" />'
            )
    return ""


def _fmt_dt(value: Any, fallback: Optional[str] = None) -> str:
    if value is None or value == "" or value == "0000-00-00":
        return fallback or "—"
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value).strip()
        dt = None
        for fmt in (
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%dT%H:%M:%S",
            "%Y-%m-%dT%H:%M:%S.%f",
            "%Y-%m-%d",
            "%d M %Y %I:%M %p",
        ):
            try:
                dt = datetime.strptime(s.replace("Z", "")[:26], fmt)
                break
            except ValueError:
                continue
        if dt is None:
            try:
                dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            except ValueError:
                return _esc(s)
    # PHP: d M Y g:i A  e.g. 22 Jul 2026 10:43 AM
    h12 = dt.hour % 12 or 12
    ampm = "AM" if dt.hour < 12 else "PM"
    return f"{dt.day} {dt.strftime('%b')} {dt.year} {h12}:{dt.strftime('%M')} {ampm}"


def _civil_status(raw: Any) -> str:
    if raw is None or raw == "":
        return "—"
    cmap = {
        "0": "—",
        0: "—",
        "1": "Single",
        1: "Single",
        "2": "Married",
        2: "Married",
        "3": "Widowed",
        3: "Widowed",
        "4": "Separated",
        4: "Separated",
        "single": "Single",
        "married": "Married",
        "widowed": "Widowed",
        "separated": "Separated",
    }
    if raw in cmap:
        return cmap[raw]
    low = str(raw).strip().lower()
    if low in cmap:
        return cmap[low]
    s = str(raw).strip()
    return s if s else "—"


def build_lab_report_html(
    patient: dict,
    shap_data: Optional[dict] = None,
    user_name: str = "Healthcare Professional",
) -> str:
    """Build lab-style report HTML matching the clinical PDF reference."""
    shap_data = shap_data or {}
    pid_num = re.sub(r"\D+", "", str(patient.get("patient_id") or "")) or "000"
    patient_id_formatted = f"PMOS-{int(pid_num):03d}" if pid_num.isdigit() else f"PMOS-{pid_num}"

    dob_display = "—"
    dob_raw = patient.get("date_of_birth") or patient.get("DOB")
    if dob_raw and str(dob_raw) not in ("", "0000-00-00"):
        try:
            if isinstance(dob_raw, datetime):
                dob_display = f"{dob_raw.day} {dob_raw.strftime('%b')} {dob_raw.year}"
            else:
                dt = datetime.strptime(str(dob_raw)[:10], "%Y-%m-%d")
                dob_display = f"{dt.day} {dt.strftime('%b')} {dt.year}"
        except ValueError:
            dob_display = str(dob_raw)

    released = _fmt_dt(_now())
    sample_source = (
        patient.get("screening_created_at")
        or patient.get("created_at")
        or patient.get("last_screened_at")
        or patient.get("history_created_at")
        or patient.get("updated_at")
        or patient.get("date_added")
    )
    sample_received = _fmt_dt(sample_source, fallback=released)

    logo_html = _logo_html()
    patient_name = str(patient.get("patient_name") or patient.get("name") or "UNKNOWN PATIENT").strip().upper()
    age = patient.get("age") if patient.get("age") not in (None, "") else patient.get("Age_yrs", "—")
    age_display = f"{age} years" if _is_num(age) else str(age)
    gender = str(patient.get("gender") or "F").upper()
    referring = str(patient.get("reffered_by") or patient.get("referred_by") or "").strip() or "—"
    contact = str(patient.get("contact_no") or "").strip() or "—"
    address = str(patient.get("address") or "").strip() or "—"
    occupation = str(patient.get("occupation") or "").strip() or "—"
    religion = str(patient.get("religion") or "").strip() or "—"
    civil = _civil_status(patient.get("civil_status"))

    recs_raw = str(patient.get("clinical_recommendations") or patient.get("recommendations") or "").strip()
    wet_line = "_______________________________________________________________"
    wet_count = 10 if recs_raw else 12
    wet_ink = (
        '<p style="font-size:10px;line-height:2.05;margin:0;">'
        + "<br/>".join([wet_line] * wet_count)
        + "</p>"
    )
    if recs_raw:
        lines = recs_raw.splitlines() or [recs_raw]
        recs_body_html = (
            '<p style="font-size:10px;line-height:1.45;margin:0 0 12px 0;">'
            + "<br/>".join(_esc(ln) for ln in lines)
            + "</p>"
            + wet_ink
        )
    else:
        recs_body_html = wet_ink

    clinical_score = patient.get("XGBoost_diagnosis_probability_percentage")
    if clinical_score in (None, ""):
        clinical_score = patient.get("clinical_score_percentage")
    imaging_score = patient.get("CNN_diagnosis_probability_percentage")
    if imaging_score in (None, ""):
        imaging_score = patient.get("imaging_score_percentage")
    final_score = patient.get("Overall_diagnosis_probability_percentage")
    if final_score in (None, ""):
        final_score = patient.get("overall_diagnosis_percentage")

    xgboost_dx = _map_dx(
        patient.get("XGBoost_diagnosis")
        or patient.get("xgboost_diagnosis")
        or patient.get("clinical_diagnosis")
        or ""
    )
    cnn_dx = _map_dx(
        patient.get("CNN_diagnosis")
        or patient.get("cnn_diagnosis")
        or patient.get("imaging_diagnosis")
        or ""
    )
    final_dx = _map_dx(
        patient.get("Overall_diagnosis") or patient.get("overall_diagnosis") or "Pending"
    )
    is_pos = "positive" in final_dx.lower()
    is_border = "borderline" in final_dx.lower()
    final_dx_cell = _abnormal_html(final_dx, "▲" if is_pos else "") if (is_pos or is_border) else _esc(final_dx)
    final_plain = _esc(_dx_plain(final_dx))

    personal_rows = "".join(
        [
            _info_row("Patient ID", patient_id_formatted),
            _info_row("Full Name", patient_name),
            _info_row("Date of Birth", dob_display),
            _info_row("Age", age_display),
            _info_row("Sex / Gender", gender),
            _info_row("Contact Number", contact),
            _info_row("Address", address),
            _info_row("Civil Status", civil),
            _info_row("Occupation", occupation),
            _info_row("Religion", religion),
            _info_row("Referring Physician", referring),
        ]
    )

    clinical_rows = ""
    clinical_rows += _group_row("A. Vitals & Body Measurements")
    bmi = patient.get("BMI")
    bmi_abn = _is_num(bmi) and float(bmi) >= 25
    clinical_rows += _result_row("Weight", _pick(patient, ["Weight_kg", "weight_kg"], 1), "kg", "")
    clinical_rows += _result_row("Height", _pick(patient, ["Height_cm", "height_cm"], 1), "cm", "")
    clinical_rows += _result_row(
        "Body Mass Index (BMI)",
        _fmt(bmi, 1),
        "kg/m²",
        "18.5 – 24.9 (normal)",
        bmi_abn,
        "▲" if bmi_abn else "",
    )
    clinical_rows += _result_row(
        "Blood Group", _blood_group(patient.get("Blood_Group") or patient.get("blood_group")), "", ""
    )
    clinical_rows += _result_row(
        "Pulse Rate", _pick(patient, ["Pulse_rate_bpm", "Pulse_rate", "pulse_rate"]), "bpm", "60 – 100"
    )
    clinical_rows += _result_row(
        "Respiratory Rate",
        _pick(patient, ["RR_breath_min", "RR_breath", "rr_breath"]),
        "breaths/min",
        "12 – 20",
    )
    clinical_rows += _result_row(
        "Hemoglobin", _pick(patient, ["Hb_g_dl", "Hemoglobin", "hemoglobin"], 1), "g/dL", "12.0 – 15.5"
    )
    clinical_rows += _result_row(
        "Waist Circumference", _pick(patient, ["Waist_inch", "waist_inch"], 1), "in", ""
    )
    clinical_rows += _result_row(
        "Hip Circumference", _pick(patient, ["Hip_inch", "hip_inch"], 1), "in", ""
    )
    clinical_rows += _result_row(
        "Waist–Hip Ratio", _pick(patient, ["Waist_hip_ratio", "waist_hip_ratio"], 2), "", ""
    )

    clinical_rows += _group_row("B. Hormone Levels")
    clinical_rows += _result_row(
        "LH (Luteinizing Hormone)",
        _pick(patient, ["LH_mIU_mL", "LH_level", "lh_level"], 2),
        "mIU/mL",
        "Varies by cycle day",
    )
    clinical_rows += _result_row(
        "FSH (Follicle-Stimulating Hormone)",
        _pick(patient, ["FSH_mIU_mL", "FSH_level", "fsh_level"], 2),
        "mIU/mL",
        "Varies by cycle day",
    )
    clinical_rows += _result_row(
        "LH/FSH Ratio",
        _pick(patient, ["LH_FSH_Ratio", "lh_fsh_ratio", "FSH_LH"], 2),
        "",
        "Often elevated in PMOS",
    )
    clinical_rows += _result_row(
        "AMH (Anti-Müllerian Hormone)",
        _pick(patient, ["AMH_ng_mL", "AMH_level", "amh_level"], 2),
        "ng/mL",
        "Age-dependent",
    )
    clinical_rows += _result_row(
        "Prolactin (PRL)", _pick(patient, ["PRL_ng_mL", "PRL_level", "prl_level"], 2), "ng/mL", "4.8 – 23.3"
    )
    clinical_rows += _result_row(
        "TSH (Thyroid-Stimulating Hormone)",
        _pick(patient, ["TSH_mIU_L", "TSH_level", "tsh_level"], 2),
        "mIU/L",
        "0.4 – 4.0",
    )
    clinical_rows += _result_row(
        "Vitamin D3",
        _pick(patient, ["Vit_D3_ng_mL", "Vitamin_D3_level", "vitamin_d3_level"], 2),
        "ng/mL",
        "30 – 100",
    )
    clinical_rows += _result_row(
        "β-hCG (First reading)",
        _pick(patient, ["I_beta_HCG_mIU_mL", "I_Beta_HCG", "i_beta_hcg"], 2),
        "mIU/mL",
        "",
    )
    clinical_rows += _result_row(
        "β-hCG (Second reading)",
        _pick(patient, ["II_beta_HCG_mIU_mL", "II_Beta_HCG", "ii_beta_hcg"], 2),
        "mIU/mL",
        "",
    )
    clinical_rows += _result_row("Blood Draw Date", _pick(patient, ["blood_draw_date"]), "", "")
    clinical_rows += _result_row(
        "Last Menstrual Period (LMP)", _pick(patient, ["last_menstrual_period_date", "LMP"]), "", ""
    )

    clinical_rows += _group_row("C. Reproductive History")
    cycle_text, cycle_abn = _cycle_regularity(
        patient.get("CycleR_I")
        or patient.get("Cycle_R_I")
        or patient.get("Cycle")
        or patient.get("Cycle_regularity")
        or patient.get("cycle_regularity")
    )
    clinical_rows += _result_row(
        "Menstrual Cycle Length",
        _pick(patient, ["Cycle_length_days", "Cycle_length", "cycle_length"]),
        "days",
        "21 – 35",
    )
    clinical_rows += _result_row(
        "Cycle Regularity", cycle_text, "", "", cycle_abn, "▲" if cycle_abn else ""
    )
    clinical_rows += _result_row(
        "Years Married",
        _pick(patient, ["Marriage_Status_years", "Marriage_duration", "marriage_duration"]),
        "years",
        "",
    )
    clinical_rows += _result_row(
        "Currently Pregnant", _yn(patient.get("Pregnant") or patient.get("Pregnant_status")), "", ""
    )
    clinical_rows += _result_row(
        "Number of Abortions",
        _pick(patient, ["No_of_abortions", "No_abortions", "no_abortions"]),
        "",
        "",
    )

    clinical_rows += _group_row("D. Metabolic Markers")
    clinical_rows += _result_row(
        "Random Blood Sugar (RBS)", _pick(patient, ["RBS_mg_dl", "RBS", "rbs"], 1), "mg/dL", "70 – 140"
    )
    clinical_rows += _result_row("Hours Fasting Before RBS", _pick(patient, ["fasting_hours"]), "hours", "")
    clinical_rows += _result_row(
        "Progesterone",
        _pick(patient, ["PRG_ng_mL", "Progesterone_level", "progesterone_level"], 2),
        "ng/mL",
        "Varies by cycle day",
    )
    clinical_rows += _result_row(
        "Blood Pressure — Systolic",
        _pick(patient, ["BP_Systolic_mmHg", "BP_systolic", "bp_systolic"]),
        "mmHg",
        "< 120",
    )
    clinical_rows += _result_row(
        "Blood Pressure — Diastolic",
        _pick(patient, ["BP_Diastolic_mmHg", "BP_diastolic", "bp_diastolic"]),
        "mmHg",
        "< 80",
    )

    clinical_rows += _group_row("E. Ultrasound Measurements")
    clinical_rows += _result_row("Ultrasound Scan Date", _pick(patient, ["ultrasound_date"]), "", "")
    clinical_rows += _result_row(
        "Imaging Modality",
        _pick(patient, ["ultrasound_modality", "Ultrasound_modality"]),
        "",
        "TVUS preferred",
    )
    clinical_rows += _result_row(
        "Follicle Count — Left Ovary",
        _pick(patient, ["Follicle_no_L", "follicle_no_L"]),
        "",
        "≤ 12 typical",
    )
    clinical_rows += _result_row(
        "Follicle Count — Right Ovary",
        _pick(patient, ["Follicle_no_R", "follicle_no_R"]),
        "",
        "≤ 12 typical",
    )
    clinical_rows += _result_row(
        "Average Follicle Size — Left",
        _pick(patient, ["Avg_F_size_L_mm", "Avg_F_size_L", "avg_f_size_L"], 1),
        "mm",
        "",
    )
    clinical_rows += _result_row(
        "Average Follicle Size — Right",
        _pick(patient, ["Avg_F_size_R_mm", "Avg_F_size_R", "avg_f_size_R"], 1),
        "mm",
        "",
    )
    clinical_rows += _result_row(
        "Endometrial Thickness", _pick(patient, ["Endometrium_mm", "endometrium_mm"], 1), "mm", ""
    )

    clinical_rows += _group_row("F. Symptoms & Lifestyle")
    for label, key in (
        ("Unexplained Weight Gain", "Weight_gain"),
        ("Excess Hair Growth (Hirsutism)", "Hair_growth"),
        ("Skin Darkening", "Skin_darkening"),
        ("Hair Loss", "Hair_loss"),
        ("Acne / Pimples", "Pimples"),
        ("Regular Fast-Food Intake", "Fast_food"),
        ("Regular Exercise", "Reg_Exercise"),
    ):
        clinical_rows += _result_row(label, _yn(patient.get(key)), "", "Yes / No")

    # SHAP
    shap_rows = (
        "<tr>"
        '<th style="padding:4px;border-top:1px solid #000;border-bottom:1px solid #000;border-left:none;'
        'border-right:none;font-size:9px;font-weight:bold;width:8%;background:transparent;">RANK</th>'
        '<th style="padding:4px;border-top:1px solid #000;border-bottom:1px solid #000;border-left:none;'
        'border-right:none;font-size:9px;font-weight:bold;width:42%;background:transparent;">CLINICAL PARAMETER</th>'
        '<th style="padding:4px;border-top:1px solid #000;border-bottom:1px solid #000;border-left:none;'
        'border-right:none;font-size:9px;font-weight:bold;width:20%;background:transparent;">CONTRIBUTION</th>'
        '<th style="padding:4px;border-top:1px solid #000;border-bottom:1px solid #000;border-left:none;'
        'border-right:none;font-size:9px;font-weight:bold;width:30%;background:transparent;">HOW IT AFFECTED THE RESULT</th>'
        "</tr>"
    )
    contribs = shap_data.get("top_contributions") if isinstance(shap_data, dict) else None
    if isinstance(contribs, list) and contribs:
        for i, contrib in enumerate(contribs[:10]):
            if not isinstance(contrib, dict):
                continue
            feat = _feature_label(contrib.get("feature") or f"Feature {i + 1}")
            sv_num = float(contrib.get("shap_value") or 0)
            sv = f"{sv_num:.4f}"
            pos = sv_num >= 0
            direction = (
                "Increased likelihood of a positive screen"
                if pos
                else "Decreased likelihood (protective)"
            )
            contrib_cell = (
                _abnormal_html(sv, "▲")
                if pos
                else f'<span style="color:#0a6;">{_esc(sv)} ▼</span>'
            )
            shap_rows += (
                "<tr>"
                f'<td style="padding:3px 4px;border:none;font-size:10px;">{i + 1}</td>'
                f'<td style="padding:3px 4px;border:none;font-size:10px;">{_esc(feat)}</td>'
                f'<td style="padding:3px 4px;border:none;font-size:10px;">{contrib_cell}</td>'
                f'<td style="padding:3px 4px;border:none;font-size:9px;color:#333;">{_esc(direction)}</td>'
                "</tr>"
            )
    else:
        shap_rows += (
            '<tr><td colspan="4" style="padding:8px 6px;font-size:11px;color:#555;">'
            "Top contributing factors are not available for this report. They appear after clinical analysis is completed."
            "</td></tr>"
        )

    us_src = _img_src(patient.get("Ultrasound_image") or patient.get("ultrasound_image") or "")
    gc_src = _img_src(
        patient.get("gradcam_visualization")
        or patient.get("gradcam_image")
        or patient.get("GradCAM_image")
        or ""
    )
    if us_src or gc_src:
        imaging_html = '<table style="width:100%;border-collapse:collapse;margin-top:6px;"><tr>'
        if us_src:
            imaging_html += (
                '<td style="width:50%;padding:6px;text-align:center;vertical-align:top;">'
                '<p style="font-size:10px;font-weight:bold;margin-bottom:6px;">ULTRASOUND IMAGE</p>'
                f'<img class="pcode-pdf-img" src="{_esc(us_src)}" alt="Ultrasound" '
                'style="max-width:100%;max-height:280px;border:1px solid #ccc;" />'
                '<p style="font-size:9px;color:#555;margin-top:4px;">Original scan submitted for review</p>'
                "</td>"
            )
        if gc_src:
            imaging_html += (
                '<td style="width:50%;padding:6px;text-align:center;vertical-align:top;">'
                '<p style="font-size:10px;font-weight:bold;margin-bottom:6px;">AI ATTENTION MAP (EigenCAM)</p>'
                f'<img class="pcode-pdf-img" src="{_esc(gc_src)}" alt="AI attention heatmap" '
                'style="max-width:100%;max-height:280px;border:1px solid #ccc;" />'
                '<p style="font-size:9px;color:#555;margin-top:4px;">Warmer colors = areas the imaging model focused on</p>'
                "</td>"
            )
        elif us_src:
            imaging_html += (
                '<td style="width:50%;padding:6px;text-align:center;vertical-align:top;color:#666;font-size:10px;">'
                '<p style="font-size:10px;font-weight:bold;margin-bottom:6px;">AI ATTENTION MAP (EigenCAM)</p>'
                "Heatmap was not available for this export. Complete imaging analysis in XAI Insights to include it."
                "</td>"
            )
        imaging_html += "</tr></table>"
        imaging_html += (
            '<p class="note">For patients: the colored overlay does not mean disease by itself — it shows which parts '
            "of the image most influenced the AI. For clinicians: correlate with follicle morphology and clinical "
            "findings before counseling.</p>"
        )
    else:
        imaging_html = '<p class="note">No ultrasound image was attached to this report.</p>'

    clin_pct = f"{float(clinical_score):.1f}%" if _is_num(clinical_score) else _empty()
    img_pct = f"{float(imaging_score):.1f}%" if _is_num(imaging_score) else _empty()
    comb_pct = f"{float(final_score):.1f}%" if _is_num(final_score) else _empty()
    clin_abn = "positive" in xgboost_dx.lower() or "borderline" in xgboost_dx.lower()
    img_abn = "positive" in cnn_dx.lower() or "borderline" in cnn_dx.lower()

    dx_rows = ""
    dx_rows += _dx_row(
        "Clinical Screening Result (AI)",
        xgboost_dx,
        clin_abn,
        "▲" if "positive" in xgboost_dx.lower() else "",
    )
    dx_rows += _dx_row("Clinical Likelihood Score", clin_pct)
    dx_rows += _ob_final_dx_row("Clinical Final Diagnosis (OB-GYN)")
    dx_rows += _dx_row(
        "Ultrasound / Imaging Screening Result (AI)",
        cnn_dx,
        img_abn,
        "▲" if "positive" in cnn_dx.lower() else "",
    )
    dx_rows += _dx_row("Ultrasound / Imaging Likelihood Score", img_pct)
    dx_rows += _ob_final_dx_row("Ultrasound Final Diagnosis (OB-GYN)")
    dx_rows += _dx_row(
        "Combined Screening Result (AI)",
        final_dx_cell,
        is_pos or is_border,
        "▲" if is_pos else "",
    )
    dx_rows += _dx_row("Combined Likelihood Score", comb_pct)
    dx_rows += _ob_final_dx_row("Combined Final Diagnosis (OB-GYN)")

    released_esc = _esc(released)
    sample_esc = _esc(sample_received)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>PMOS Screening Report — {patient_id_formatted}</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; font-size: 10px; line-height: 1.35; }}
  .container {{ max-width: 800px; margin: 0 auto; padding: 14px 18px 22px; background: #fff; }}
  .section {{ margin: 0 0 12px; padding: 0; border: none; page-break-inside: avoid; }}
  .rule {{ border: none; border-top: 1px solid #000; margin: 6px 0; }}
  .rule-thick {{ border: none; border-top: 1.5px solid #000; margin: 8px 0; }}
  .lab-header {{ width: 100%; border-collapse: collapse; margin-bottom: 4px; }}
  .lab-header td {{ vertical-align: top; padding: 0; }}
  .brand-logo {{ width: 48px; height: 48px; display: block; }}
  .brand-name {{ font-size: 16px; font-weight: 700; letter-spacing: 0.3px; color: #5b2d8e; }}
  .brand-sub {{ font-size: 10px; color: #333; margin-top: 2px; }}
  .clinic-meta {{ text-align: right; font-size: 9px; line-height: 1.35; color: #222; }}
  .clinic-meta strong {{ font-size: 10px; display: block; margin-bottom: 2px; }}
  .disclaimer {{ font-size: 8.5px; color: #333; margin: 6px 0; text-align: center; font-style: italic; }}
  .results {{ width: 100%; border-collapse: collapse; border: none; }}
  .results th {{ text-align: left; font-size: 9px; font-weight: 700; padding: 4px; border-top: 1px solid #000; border-bottom: 1px solid #000; border-left: none; border-right: none; background: transparent; text-transform: uppercase; }}
  .results td {{ border: none; }}
  .results tr.pcode-group-row td {{ border-top: 0.5px solid #666; border-bottom: 0.5px solid #666; border-left: none; border-right: none; background: transparent; }}
  .section-title {{ font-size: 11px; font-weight: 700; margin: 0 0 4px; border: none; border-top: 1px solid #000; border-bottom: 1px solid #000; background: transparent; padding: 4px 0; }}
  .section-help {{ font-size: 8.5px; color: #444; margin: 0 0 5px; line-height: 1.35; }}
  .note {{ font-size: 8.5px; color: #333; margin: 5px 0; }}
  .important {{ font-size: 9px; margin-top: 6px; }}
  .plain-box {{ border: none; border-top: 0.6px solid #666; border-bottom: 0.6px solid #666; background: transparent; padding: 6px 2px; margin-top: 6px; font-size: 9px; }}
  .sign-table {{ width: 100%; border-collapse: collapse; margin-top: 8px; border: none; }}
  .flags {{ font-size: 9px; margin-top: 10px; }}
  .computer {{ font-size: 10px; font-weight: 700; text-align: center; margin-top: 10px; letter-spacing: 0.4px; }}
  .page-no {{ font-size: 9px; text-align: right; margin-top: 4px; }}
</style>
</head>
<body>
<div class="container">

<div class="section" data-section="cover">
  <table class="lab-header pcode-system-header">
    <tr>
      <td style="width:58%;">
        <table style="border-collapse:collapse;border:none;"><tr>
          <td style="vertical-align:middle;padding:0 8px 0 0;border:none;width:56px;">{logo_html}</td>
          <td style="vertical-align:middle;padding:0;border:none;">
            <div class="brand-name">P-Code</div>
            <div class="brand-sub">PMOS Clinical Decision Support System</div>
            <div class="brand-sub">AI-assisted screening report for Polyendocrine Metabolic Ovarian Syndrome (PMOS)</div>
          </td>
        </tr></table>
      </td>
      <td class="clinic-meta" style="width:42%;">
        <strong>FOR PATIENT AND PHYSICIAN REVIEW</strong>
        Generated: {released_esc}<br>
        Report ID: {patient_id_formatted}
      </td>
    </tr>
  </table>
  <hr class="rule">
  <p class="disclaimer note">This report summarizes screening inputs and AI-assisted results to support clinical discussion. It is not a standalone medical diagnosis.</p>
  <hr class="rule">
</div>

<div class="section" data-section="patient">
  <h2 class="section-title">1. Patient Information</h2>
  <table class="results">
    {personal_rows}
  </table>
</div>

<div class="section" data-section="clinical">
  <h2 class="section-title">2. Clinical Findings</h2>
  <table class="results">
    <tr><th style="width:34%;">PARAMETER</th><th style="width:22%;">RESULT</th><th style="width:16%;">UNIT</th><th style="width:28%;">REFERENCE / NOTE</th></tr>
    {clinical_rows}
  </table>
</div>

<div class="section" data-section="shap">
  <h2 class="section-title">3. Top 10 Factors Influencing the Clinical Screening</h2>
  <p class="section-help">These are the clinical parameters that most influenced the AI clinical model for this patient (SHAP explanation). Use them to understand <em>why</em> the clinical score leaned positive or negative — not as isolated diagnoses.</p>
  <table class="results">{shap_rows}</table>
  <p class="note"><strong>How to read this:</strong> A positive contribution (▲) pushed the result toward a positive PMOS screen. A negative contribution (▼) pushed toward a negative / protective screen. Larger absolute values had more influence.</p>
</div>

<div class="section" data-section="imaging">
  <h2 class="section-title">4. Ultrasound Image and AI Attention Map</h2>
  <p class="section-help">Side-by-side view of the submitted ultrasound and the EigenCAM heatmap showing where the imaging model focused.</p>
  {imaging_html}
</div>

<div class="section" data-section="diagnosis">
  <h2 class="section-title">5. Screening Results and Clinical Validation</h2>
  <p class="section-help">AI screening scores are shown first. After each likelihood score, the OB-GYN marks a Final Diagnosis row. Physician validation is required before counseling or treatment planning.</p>
  <table class="results">
    <tr><th style="width:55%;">RESULT ITEM</th><th style="width:45%;">FINDING</th></tr>
    {dx_rows}
  </table>
  <div class="plain-box" style="margin-top:8px;padding:6px 4px;">
    <p class="note" style="margin:0 0 4px 0;"><strong>In plain language:</strong> {final_plain}</p>
    <p class="note" style="margin:0;">Discuss this report with your doctor. Lifestyle, menstrual history, and further tests may still be needed.</p>
  </div>
  <hr class="rule-thick">
  <p style="font-size:10px;padding:6px 0;margin:0;"><strong>Clinical data / sample date:</strong> {sample_esc}</p>
  <hr class="rule-thick">
  <p class="important" style="margin:8px 0;line-height:1.35;"><strong>Important notice for patients and doctors</strong><br/>
    This is a computer-assisted screening aid for Polyendocrine Metabolic Ovarian Syndrome (PMOS). It must be interpreted by a qualified clinician together with history, examination, and other investigations. It is not a standalone diagnosis and does not replace professional medical advice.
  </p>
</div>

<div class="section" data-section="recommendations">
  <h2 class="section-title">6. Recommendations</h2>
  <table class="results" style="width:100%;border-collapse:collapse;">
    <tr>
      <td style="padding:12px 4px 18px;border:none;border-top:0.6px solid #666;border-bottom:0.6px solid #666;vertical-align:top;">
        {recs_body_html}
      </td>
    </tr>
  </table>
  <p class="flags" style="margin-top:10px;"><strong>Result flags:</strong> &nbsp; Lower / protective ▼ &nbsp; Higher / elevated ▲</p>
  <table class="sign-table">
    <tr>
      <td style="padding:10px 4px;line-height:1.45;text-align:left;vertical-align:top;font-size:12px;">
        <strong style="font-size:12px;">Validated by (Consulting OB-GYN)</strong><br/>
        Name: ____________________________<br/>
        Signature: _______________________<br/>
        Date: ____________________________
      </td>
    </tr>
  </table>
</div>

<p class="computer pcode-pdf-footer-computer">THIS IS A COMPUTER-GENERATED SCREENING REPORT.</p>
<p class="page-no pcode-pdf-footer-meta">Report ID: {patient_id_formatted} &nbsp;|&nbsp; System: P-Code PMOS Decision Support</p>

</div>
</body>
</html>"""


def generate_lab_pdf_bytes(
    patient: dict,
    shap_data: Optional[dict] = None,
    user_name: str = "Healthcare Professional",
) -> bytes:
    """Render lab HTML to PDF bytes via ReportLab converter."""
    html = build_lab_report_html(patient, shap_data, user_name)

    import sys

    api_dir = str(_API_DIR)
    if api_dir not in sys.path:
        sys.path.insert(0, api_dir)
    from html_to_pdf import generate_pdf  # noqa: WPS433

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        out_path = tmp.name
    try:
        generate_pdf(html, out_path)
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass
