#!/C:/Users/USER/AppData/Local/Programs/Python/Python313/python.exe
"""
XGBoost Model Prediction for Clinical PCOS Data
"""
import json
import sys
import pickle
import numpy as np
import pandas as pd
from pathlib import Path

try:
    import xgboost as xgb
except ImportError:
    print(json.dumps({
        'success': False,
        'error': 'XGBoost not installed. Please install: pip install xgboost'
    }))
    sys.exit(1)

try:
    import shap
    SHAP_AVAILABLE = True
except ImportError as e:
    SHAP_AVAILABLE = False
    SHAP_ERROR = str(e)

def convert_to_python_types(obj):
    """
    Recursively convert numpy/pandas types to Python native types for JSON serialization.
    Handles: numpy types, pandas types, None, NaN, lists, dicts, etc.
    NaN values are converted to null (None) for proper JSON representation.
    """
    if obj is None:
        return None
    elif isinstance(obj, (np.floating, np.float64, np.float32, np.float16)):
        # Handle NaN values - convert them to None for JSON serialization
        if np.isnan(obj):
            return None
        return float(obj)
    elif isinstance(obj, (np.integer, np.int64, np.int32, np.int16, np.int8)):
        return int(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, (pd.Series, pd.Index)):
        return obj.tolist()
    elif isinstance(obj, dict):
        return {key: convert_to_python_types(value) for key, value in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [convert_to_python_types(item) for item in obj]
    elif isinstance(obj, (bool, np.bool_)):
        return bool(obj)
    elif isinstance(obj, float):
        # Handle Python float NaN as well
        if np.isnan(obj):
            return None
        return obj
    else:
        return obj

def load_xgboost_model(model_path):
    """Load the XGBoost model"""
    try:
        # Try loading with pickle using bytes encoding (handles cross-version compatibility)
        with open(model_path, 'rb') as f:
            model = pickle.load(f, encoding='bytes')
        return model
    except (pickle.UnpicklingError, EOFError) as e:
        raise Exception(f"Model file is corrupted. Please regenerate from Training page. Error: {str(e)[:100]}")
    except FileNotFoundError:
        raise Exception(f"Model file not found at {model_path}. Please train the model first from the Training page.")
    except Exception as e:
        raise Exception(f"Failed to load XGBoost model: {str(e)}")

def prepare_clinical_data(data_dict, model=None):
    """Prepare clinical data for XGBoost prediction"""
    try:
        # Complex mapping: handles form field names, database column names, and model feature names
        # Maps to a normalized intermediate form, then to model features
        field_mapping = {
            # Basic vital signs and anthropometry
            # Maps form/db field names to EXACT model feature names
            'age': ' Age (yrs)',  # Model feature has leading space
            'Age_yrs': ' Age (yrs)',  # Model feature has leading space
            'Weight_kg': 'Weight (Kg)',
            'Height_cm': 'Height(Cm) ',  # Model feature has trailing space
            'BMI': 'BMI',
            'Blood_Group': 'Blood Group',
            
            # Cardiovascular measurements
            'Pulse_rate': 'Pulse rate(bpm) ',  # Model feature has trailing space
            'Pulse_rate_bpm': 'Pulse rate(bpm) ',  # Model feature has trailing space
            'RR_breath': 'RR (breaths/min)',
            'RR_breath_min': 'RR (breaths/min)',
            'BP_systolic': 'BP _Systolic (mmHg)',  # Model feature: 'BP _' with underscore-space
            'BP_Systolic_mmHg': 'BP _Systolic (mmHg)',  # Model feature: 'BP _' with underscore-space
            'BP_diastolic': 'BP _Diastolic (mmHg)',  # Model feature: 'BP _' with underscore-space
            'BP_Diastolic_mmHg': 'BP _Diastolic (mmHg)',  # Model feature: 'BP _' with underscore-space
            
            # Hemoglobin and CBC
            'Hemoglobin': 'Hb(g/dl)',
            'Hb_g_dl': 'Hb(g/dl)',
            
            # Menstrual and reproductive history
            'Cycle_R_I': 'Cycle(R/I)',  # Model feature uses R/I not R/
            'CycleR_I': 'Cycle(R/I)',  # Model feature uses R/I not R/
            'Cycle_length': 'Cycle length(days)',
            'Cycle_length_days': 'Cycle length(days)',
            'Marriage_duration': 'Marraige Status (Yrs)',  # Model feature has typo: "Marraige"
            'Marriage_Status_years': 'Marraige Status (Yrs)',  # Model feature has typo: "Marraige"
            'Pregnant_status': 'Pregnant(Y/N)',
            'Pregnant': 'Pregnant(Y/N)',
            'No_abortions': 'No. of abortions',
            'No_of_abortions': 'No. of abortions',
            
            # Beta HCG levels
            'I_Beta_HCG': '  I   beta-HCG(mIU/mL)',  # Model feature has specific spacing
            'I_beta_HCG_mIU_mL': '  I   beta-HCG(mIU/mL)',  # Model feature has specific spacing
            'II_Beta_HCG': 'II    beta-HCG(mIU/mL)',  # Model feature has specific spacing
            'II_beta_HCG_mIU_mL': 'II    beta-HCG(mIU/mL)',  # Model feature has specific spacing
            
            # Hormones - Reproductive
            'LH_level': 'LH(mIU/mL)',
            'LH_mIU_mL': 'LH(mIU/mL)',
            'FSH_level': 'FSH(mIU/mL)',
            'FSH_mIU_mL': 'FSH(mIU/mL)',
            'FSH_LH': 'FSH/LH',
            'AMH_level': 'AMH(ng/mL)',
            'AMH_ng_mL': 'AMH(ng/mL)',
            'PRL_level': 'PRL(ng/mL)',
            'PRL_ng_mL': 'PRL(ng/mL)',
            
            # Hormones - Thyroid and others
            'TSH_level': 'TSH (mIU/L)',
            'TSH_mIU_L': 'TSH (mIU/L)',
            'Progesterone_level': 'PRG(ng/mL)',
            'PRG_ng_mL': 'PRG(ng/mL)',
            'Vitamin_D3_level': 'Vit D3 (ng/mL)',
            'Vit_D3_ng_mL': 'Vit D3 (ng/mL)',
            
            # Metabolic markers
            'RBS': 'RBS(mg/dl)',
            'RBS_mg_dl': 'RBS(mg/dl)',
            
            # Body composition and anthropometry
            'Waist_inch': 'Waist(inch)',
            'Hip_inch': 'Hip(inch)',
            'Waist_hip_ratio': 'Waist:Hip Ratio',
            
            # PCOS symptoms (from checkboxes: 1 if checked, 0 if not)
            'Weight_gain': 'Weight gain(Y/N)',
            'Hair_growth': 'hair growth(Y/N)',  # Model feature: lowercase 'hair'
            'Skin_darkening': 'Skin darkening (Y/N)',
            'Hair_loss': 'Hair loss(Y/N)',
            'Pimples': 'Pimples(Y/N)',
            
            # Lifestyle factors (from checkboxes: 1 if checked, 0 if not)
            'Fast_food': 'Fast food (Y/N)',
            'Regular_exercise': 'Reg.Exercise(Y/N)',  # Model feature: 'Reg.Exercise' with period
            'Reg_Exercise': 'Reg.Exercise(Y/N)',  # Model feature: 'Reg.Exercise' with period
            
            # Ultrasound findings - Follicles (mapped to model's exact feature names)
            'Follicle_no_L': 'Follicle No. (L)',  # Maps to model feature
            'Follicle_no_R': 'Follicle No. (R)',  # Maps to model feature
            'Avg_F_size_L': 'Avg. F size (L) (mm)',  # Form sends without exact suffix
            'Avg_F_size_L_mm': 'Avg. F size (L) (mm)',  # Also accept with _mm suffix
            'Avg_F_size_R': 'Avg. F size (R) (mm)',  # Form sends without exact suffix
            'Avg_F_size_R_mm': 'Avg. F size (R) (mm)',  # Also accept with _mm suffix
            
            # Ultrasound findings - Endometrium
            'Endometrium_mm': 'Endometrium (mm)',  # Maps to model feature

            # Common short aliases from forms / clients
            'AMH': 'AMH(ng/mL)',
            'LH': 'LH(mIU/mL)',
            'FSH': 'FSH(mIU/mL)',
            'TSH': 'TSH (mIU/L)',
            'PRL': 'PRL(ng/mL)',
            'PRG': 'PRG(ng/mL)',
        }

        # Checkbox Y/N fields: unchecked in the UI means explicit No (0), not "missing".
        # Leaving them as NaN lets XGBoost ignore the protective "no symptom" signal and
        # over-lean Positive on the remaining vitals/labs.
        SYMPTOM_YN_DEFAULT_ZERO = {
            'Weight gain(Y/N)',
            'hair growth(Y/N)',
            'Skin darkening (Y/N)',
            'Hair loss(Y/N)',
            'Pimples(Y/N)',
            'Fast food (Y/N)',
        }
        
        # Get expected feature names from model if available
        expected_features = None
        if model is not None and hasattr(model, 'get_booster'):
            try:
                booster = model.get_booster()
                if hasattr(booster, 'feature_names') and booster.feature_names:
                    expected_features = booster.feature_names
            except:
                pass
        
        # Remap the incoming data to model feature names
        remapped_data = {}
        for form_field, value in data_dict.items():
            # Use mapped name if available, otherwise keep original
            model_field = field_mapping.get(form_field, form_field)
            
            # Convert cycle regularity text to numeric value
            # Regular = 0 (normal/regular cycle), Irregular = 1 (irregular cycle)
            if form_field == 'Cycle_R_I' and isinstance(value, str):
                if value.lower() == 'regular':
                    remapped_data[model_field] = 0
                elif value.lower() == 'irregular':
                    remapped_data[model_field] = 1
                else:
                    remapped_data[model_field] = value  # Keep as-is if neither
            # Convert blood group type to numeric value
            # O = 1, A = 2, B = 3, AB = 4
            elif form_field == 'Blood_Group' and isinstance(value, str):
                bg_map = {'o': 1, 'a': 2, 'b': 3, 'ab': 4}
                bg_lower = value.lower().strip()
                if bg_lower in bg_map:
                    remapped_data[model_field] = bg_map[bg_lower]
                else:
                    remapped_data[model_field] = value  # Keep as-is if not recognized
            else:
                remapped_data[model_field] = value

        # Unchecked symptom checkboxes mean explicit No (0), never "missing"/NaN.
        # Inject before the feature frame is built so the model always sees 0.
        for col in SYMPTOM_YN_DEFAULT_ZERO:
            raw = remapped_data.get(col, None)
            if raw is None or raw == '':
                remapped_data[col] = 0
            elif isinstance(raw, (float, np.floating)) and np.isnan(raw):
                remapped_data[col] = 0
            elif isinstance(raw, str) and raw.strip().lower() in ('', 'nan', 'none', 'null'):
                remapped_data[col] = 0
        
        # If model provides expected features, ensure DataFrame has exactly those columns in that order
        if expected_features:
            df_dict = {}
            matched_count = 0
            unmatched_features = []
            matched_ultrasound = []
            unmatched_ultrasound = []
            
            ultrasound_model_features = {
                'Follicle No. (L)', 'Follicle No. (R)',
                'Avg. F size (L) (mm)', 'Avg. F size (R) (mm)',
                'Endometrium (mm)'
            }
            
            for feat in expected_features:
                # Try exact match first
                if feat in remapped_data:
                    df_dict[feat] = [remapped_data[feat]]
                    matched_count += 1
                    if feat in ultrasound_model_features:
                        matched_ultrasound.append(feat)
                else:
                    # Try case-insensitive match as fallback
                    found = False
                    for key in remapped_data.keys():
                        if key.lower() == feat.lower():
                            df_dict[feat] = [remapped_data[key]]
                            matched_count += 1
                            found = True
                            if feat in ultrasound_model_features:
                                matched_ultrasound.append(feat)
                            break
                    if not found:
                        df_dict[feat] = [np.nan]
                        unmatched_features.append(feat)
                        if feat in ultrasound_model_features:
                            unmatched_ultrasound.append(feat)
            
            df = pd.DataFrame(df_dict)
            
            # If ALL features are unmatched (everything is NaN), fall back to using remapped_data directly
            # This happens when expected_features don't match what we're sending
            if matched_count == 0 and remapped_data:
                # Check if remapped_data has any non-null values
                any_values = any(v is not None and v != '' for v in remapped_data.values())
                if any_values:
                    # Use remapped_data directly instead of expected_features
                    df = pd.DataFrame([remapped_data])
        else:
            # Create DataFrame from remapped data
            df = pd.DataFrame([remapped_data])
        
        # Convert numeric strings to floats, treat empty/missing as NaN
        for col in df.columns:
            try:
                val = df[col].iloc[0]
                if val == '' or val == 'nan' or val is None:
                    df[col] = np.nan
                else:
                    df[col] = pd.to_numeric(val, errors='coerce')
            except:
                df[col] = pd.to_numeric(df[col], errors='coerce')
        
        # Final guard: symptom Y/N columns must be 0 (No), never NaN.
        for col in SYMPTOM_YN_DEFAULT_ZERO:
            if col not in df.columns:
                df[col] = 0.0
                continue
            val = df[col].iloc[0]
            if pd.isna(val) or val is None or val == '':
                df.loc[df.index[0], col] = 0.0
                continue
            if isinstance(val, str) and val.strip().lower() in ('nan', 'none', 'null'):
                df.loc[df.index[0], col] = 0.0
                continue
            try:
                num = float(val)
                if np.isnan(num):
                    df.loc[df.index[0], col] = 0.0
                else:
                    df.loc[df.index[0], col] = 1.0 if num >= 0.5 else 0.0
            except Exception:
                df.loc[df.index[0], col] = 0.0

        # Clean suspicious zero values (converts them to NaN)
        # NOTE: must run after symptom defaults — symptoms are allowed to be 0.
        df = clean_suspicious_zeros(df)

        # Re-assert after clean_suspicious_zeros (symptoms are not in that list, but keep safe)
        for col in SYMPTOM_YN_DEFAULT_ZERO:
            if col in df.columns and pd.isna(df[col].iloc[0]):
                df.loc[df.index[0], col] = 0.0
        
        return df
    except Exception as e:
        raise Exception(f"Failed to prepare clinical data: {str(e)}")

def clean_suspicious_zeros(df):
    """
    Convert suspicious zero values to NaN for fields that should never be zero.
    This handles cases where data entry resulted in all-zero placeholder values.
    
    Fields that legitimately can be 0: follicle counts, abortions, pregnancy status, symptoms, lifestyle
    Fields that should NEVER be 0: vital signs, hormone levels, weight, age, etc.
    """
    
    # Define fields where 0 is suspicious and should be converted to NaN
    suspicious_zero_fields = {
        ' Age (yrs)',
        'Weight (Kg)',
        'Height(Cm) ',
        'BMI',
        'Pulse rate(bpm) ',
        'BP _Systolic (mmHg)',
        'BP _Diastolic (mmHg)',
        'Hb(g/dl)',
        'Cycle length(days)',
        'LH(mIU/mL)',
        'FSH(mIU/mL)',
        'AMH(ng/mL)',
        'PRL(ng/mL)',
        'TSH (mIU/L)',
        'PRG(ng/mL)',
        'Vit D3 (ng/mL)',
        'RBS(mg/dl)',
        'Waist(inch)',
        'Hip(inch)',
        'Waist:Hip Ratio',
        'Avg. F size (L) (mm)',  # Model's exact feature name
        'Avg. F size (R) (mm)',  # Model's exact feature name
        'Endometrium (mm)',  # Model's exact feature name
        '  I   beta-HCG(mIU/mL)',
        'II    beta-HCG(mIU/mL)',
        'RR (breaths/min)'
    }
    
    cleaned_count = 0
    for field in suspicious_zero_fields:
        if field in df.columns:
            # Count how many we're converting
            zero_count = (df[field] == 0).sum()
            cleaned_count += zero_count
            # Convert exactly 0 to NaN for these fields
            df.loc[df[field] == 0, field] = np.nan
    
    return df

def get_feature_importances_dict(model):
    """
    Extract feature importances from model as a dictionary.
    Maps feature name (string) to importance value.
    
    Args:
        model: Trained XGBoost model
        
    Returns:
        Dictionary mapping feature names to importance scores
    """
    importance_dict = {}
    try:
        if hasattr(model, 'feature_importances_'):
            importance = model.feature_importances_
            booster = model.get_booster()
            
            if hasattr(booster, 'feature_names') and booster.feature_names:
                feature_names = booster.feature_names
                # Calculate total importance for normalization
                total_importance = sum(importance)
                
                for name, imp in zip(feature_names, importance):
                    # Store both raw and normalized importance
                    importance_dict[name] = {
                        'raw_importance': float(imp),
                        'normalized_importance': float(imp / total_importance * 100) if total_importance > 0 else 0
                    }
    except Exception as e:
        # If extraction fails, return empty dict (not fatal)
        pass
    
    return importance_dict

def get_shap_explanation(model, df, raw_prediction, missing_value_mask=None):
    """
    Generate SHAP explanation for the prediction.
    Shows which features contributed most to the decision, prioritized by influence.
    Includes global feature importance for each contribution.
    
    Args:
        model: Trained XGBoost model
        df: DataFrame with features (after imputation with 0)
        raw_prediction: The raw model output (for calibration)
        missing_value_mask: Boolean mask of which values were originally missing
    """
    if not SHAP_AVAILABLE:
        return {
            'error': f'SHAP library not available: {SHAP_ERROR}',
            'available': False
        }
    
    try:
        # Extract feature importances from model
        feature_importances = get_feature_importances_dict(model)
        
        # Create SHAP explainer for XGBoost model
        explainer = shap.TreeExplainer(model)
        shap_values = explainer.shap_values(df)
        
        # For binary classification, shap_values can be a list or array
        # We want the SHAP values for the positive class (PCOS)
        if isinstance(shap_values, list):
            shap_values = shap_values[1]  # Get positive class SHAP values
        
        # Get base value (model's prior)
        base_value = explainer.expected_value
        if isinstance(base_value, list):
            base_value = base_value[1]  # Positive class base value
        
        # CALIBRATION: Adjust base_value to reflect actual class prevalence
        # Training data: 223 positive, 355 negative (39% positive prevalence)
        ACTUAL_POSITIVE_PREVALENCE = 0.386  # 223 / 578
        
        # The model's base value is often miscalibrated due to class imbalance
        # Correct it to the actual prevalence
        # This ensures the base predictions start from the true class balance
        base_value_calibrated = ACTUAL_POSITIVE_PREVALENCE
        
        # Extract feature contributions for first (and only) sample
        shap_sample = shap_values[0]
        features = df.columns.tolist()
        
        # Create list of contributions with influence metrics
        # Only include features with actual data (not NaN) AND NOT originally missing
        contributions = []
        total_positive_influence = 0
        total_negative_influence = 0
        
        # Use the missing_value_mask to filter out originally-missing fields
        # missing_mask is a list of bools: True if value was missing, False if it had data
        is_missing_value = missing_value_mask if missing_value_mask else [False] * len(features)
        
        for i, (feature, shap_val) in enumerate(zip(features, shap_sample)):
            value = df.iloc[0, i]
            
            # Skip features that are NaN (missing) OR were originally marked as missing in the input
            if pd.isna(value) or (i < len(is_missing_value) and is_missing_value[i]):
                continue
            
            # Use raw SHAP values - no clamping to preserve actual feature sensitivity
            # SHAP values represent: contribution to log-odds or probability shift
            shap_val_raw = float(shap_val)
            abs_shap_val = abs(shap_val_raw)
            
            # Determine impact direction
            impact = 'positive' if shap_val_raw > 0 else 'negative'
            
            # Track cumulative influence by direction
            if shap_val_raw > 0:
                total_positive_influence += abs_shap_val
            else:
                total_negative_influence += abs_shap_val
            
            # Influence score: raw magnitude preserves actual feature importance
            influence_score = abs_shap_val
            
            # Build contribution entry
            contrib_entry = {
                'feature': feature,
                'value': float(value) if pd.notna(value) else None,
                'shap_value': shap_val_raw,
                'abs_shap_value': float(abs_shap_val),
                'impact': impact,
                'influence_score': float(influence_score)
            }
            
            # Add global feature importance if available
            if feature in feature_importances:
                contrib_entry['global_importance'] = feature_importances[feature]['normalized_importance']
                contrib_entry['global_importance_raw'] = feature_importances[feature]['raw_importance']
            
            contributions.append(contrib_entry)
        
        # Calculate total influence for normalization
        total_influence = total_positive_influence + total_negative_influence
        
        # Sort by influence score (most important first)
        contributions = sorted(
            contributions, 
            key=lambda x: -x['influence_score']  # Sort by magnitude, descending
        )
        
        # Calculate cumulative influence percentage
        running_cumulative = 0
        for contrib in contributions:
            if total_influence > 0:
                running_cumulative += contrib['abs_shap_value']
                contrib['cumulative_influence_pct'] = (
                    (running_cumulative / total_influence * 100)
                )
            else:
                contrib['cumulative_influence_pct'] = 0
        
        # Extract ultrasound-specific contributions with importance
        ultrasound_contributions = [c for c in contributions if any(us in c['feature'] for us in ['Follicle', 'Endometrium', 'Avg'])]
        
        # Calculate summary statistics for ultrasound features
        ultrasound_importance_summary = None
        if ultrasound_contributions:
            total_ultrasound_global_importance = sum(
                c.get('global_importance', 0) for c in ultrasound_contributions
            )
            ultrasound_importance_summary = {
                'count': len(ultrasound_contributions),
                'total_global_importance_pct': round(total_ultrasound_global_importance, 2),
                'avg_global_importance_pct': round(total_ultrasound_global_importance / len(ultrasound_contributions), 2) if ultrasound_contributions else 0,
                'features': ultrasound_contributions
            }
        
        result = {
            'success': True,
            'top_contributions': contributions,  # Only non-missing fields
            'total_features_analyzed': len(contributions),
            'positive_influence_total': float(total_positive_influence),
            'negative_influence_total': float(total_negative_influence),
            'total_influence': float(total_influence),
            'prediction_direction': 'PCOS positive' if total_positive_influence > total_negative_influence else 'PCOS negative',
            'ultrasound_contributions': ultrasound_contributions,  # Extract ultrasound-specific contributions
        }
        
        # Add ultrasound importance summary if available
        if ultrasound_importance_summary:
            result['ultrasound_importance_summary'] = ultrasound_importance_summary
        
        return result
    except Exception as e:
        return {
            'success': False,
            'error': f'SHAP explanation failed: {type(e).__name__}: {str(e)[:200]}'
        }

def calibrate_for_class_imbalance(raw_prob):
    """
    Calibrate probability to account for class imbalance in training data.
    
    Training data: 223 positive, 355 negative = 39% positive, 61% negative
    
    When models are trained on imbalanced data, they learn biased decision boundaries.
    This function applies Bayes' theorem to adjust the model's probabilities.
    
    Formula: P(positive|data) = P(data|positive) * P(positive) / P(data)
    Simplified: P_cal = P_raw * prior_pos / (P_raw * prior_pos + (1-P_raw) * prior_neg)
    """
    if raw_prob is None or np.isnan(raw_prob):
        return 0.39
    
    raw_prob = float(np.clip(raw_prob, 0.001, 0.999))
    
    # Class prevalence from training data
    prior_positive = 0.386  # 223 / 578
    prior_negative = 0.614  # 355 / 578
    
    # Apply Bayes' theorem calibration
    # This adjusts the model's confidence based on actual class prevalence
    numerator = raw_prob * prior_positive
    denominator = (raw_prob * prior_positive) + ((1 - raw_prob) * prior_negative)
    
    if denominator > 0:
        calibrated = numerator / denominator
    else:
        calibrated = raw_prob
    
    return float(calibrated)

def apply_shap_aware_adjustment(probability_percentage, shap_explanation):
    """
    Adjust final probability based on balance of SHAP contributions.

    Feature-group weighting (requested):
    - 40%: Clinical symptoms + vitals/demographics + reproductive parameters + hormone levels
    - 40%: Ultrasound parameters
    - 20%: Everything else
    
    Protective (negative-impact) factors can reduce the score.
    Risk-factor *inflation* is disabled — it was over-pushing Positive even when
    classic PCOS symptoms were marked No.
    """
    if not shap_explanation or not shap_explanation.get('success'):
        return probability_percentage
    
    try:
        contributions = shap_explanation.get('top_contributions', [])
        
        # Define feature groups using model feature names
        clinical_symptoms = {
            'Weight gain(Y/N)', 'hair growth(Y/N)', 'Skin darkening (Y/N)', 
            'Hair loss(Y/N)', 'Pimples(Y/N)'
        }

        vitals_and_demographics = {
            ' Age (yrs)', 'Weight (Kg)', 'Height(Cm) ', 'BMI', 'Blood Group',
            'Pulse rate(bpm) ', 'RR (breaths/min)', 'BP _Systolic (mmHg)', 'BP _Diastolic (mmHg)',
            'Hb(g/dl)'
        }

        reproductive_parameters = {
            'Cycle(R/I)', 'Cycle length(days)', 'Marraige Status (Yrs)', 'Pregnant(Y/N)', 'No. of abortions',
            '  I   beta-HCG(mIU/mL)', 'II    beta-HCG(mIU/mL)'
        }
        
        ultrasound_findings = {
            'Follicle No. (L)', 'Follicle No. (R)',
            'Avg. F size (L) (mm)', 'Avg. F size (R) (mm)',
            'Endometrium (mm)'
        }
        
        hormonal_markers = {
            'FSH(mIU/mL)', 'LH(mIU/mL)', 'AMH(ng/mL)', 'TSH (mIU/L)',
            'PRL(ng/mL)', 'PRG(ng/mL)', 'Vit D3 (ng/mL)', 'FSH/LH'
        }

        group_clinical = clinical_symptoms | vitals_and_demographics | reproductive_parameters | hormonal_markers
        group_ultrasound = ultrasound_findings

        clinical_contrib = [c for c in contributions if c.get('feature') in group_clinical]
        ultrasound_contrib = [c for c in contributions if c.get('feature') in group_ultrasound]
        other_contrib = [c for c in contributions if c.get('feature') not in (group_clinical | group_ultrasound)]

        # Weight absences of classic symptoms more heavily when they pull negative
        symptom_multiplier = 1.75
        reproductive_multiplier = 1.35
        clinical_pos = 0.0
        clinical_neg = 0.0
        for c in clinical_contrib:
            feat = c.get('feature')
            weight = 1.0
            if feat in clinical_symptoms:
                weight = symptom_multiplier
            elif feat in reproductive_parameters:
                weight = reproductive_multiplier
            mag = c['abs_shap_value'] * weight
            if c.get('impact') == 'positive':
                clinical_pos += mag
            elif c.get('impact') == 'negative':
                clinical_neg += mag

        ultrasound_pos = sum(c['abs_shap_value'] for c in ultrasound_contrib if c.get('impact') == 'positive')
        ultrasound_neg = sum(c['abs_shap_value'] for c in ultrasound_contrib if c.get('impact') == 'negative')

        other_pos = sum(c['abs_shap_value'] for c in other_contrib if c.get('impact') == 'positive')
        other_neg = sum(c['abs_shap_value'] for c in other_contrib if c.get('impact') == 'negative')

        # Apply requested weights: Clinical 40%, Ultrasound 40%, Other 20%
        weighted_positive = (clinical_pos * 0.40) + (ultrasound_pos * 0.40) + (other_pos * 0.20)
        weighted_negative = (clinical_neg * 0.40) + (ultrasound_neg * 0.40) + (other_neg * 0.20)
        
        total_weighted = weighted_positive + weighted_negative
        
        if total_weighted > 0:
            protective_ratio = weighted_negative / total_weighted
            
            # Strong protective factors from clinical assessment → reduce score only
            if protective_ratio > 0.50:
                adjustment_factor = 1.0 - (protective_ratio - 0.50) * 1.35
                adjustment_factor = max(0.55, min(1.0, adjustment_factor))
                return probability_percentage * adjustment_factor
        
        return probability_percentage
        
    except Exception:
        return probability_percentage


def apply_symptom_absence_adjustment(probability_percentage, df):
    """
    When classic PCOS symptom checkboxes are explicitly No (0), pull the score
    down so Positive is harder to reach without positive symptom evidence.
    """
    try:
        p = float(probability_percentage)
    except Exception:
        return probability_percentage

    symptom_fields = (
        'Weight gain(Y/N)',
        'hair growth(Y/N)',
        'Skin darkening (Y/N)',
        'Hair loss(Y/N)',
        'Pimples(Y/N)',
    )

    yes = 0
    no = 0
    for col in symptom_fields:
        if col not in df.columns:
            continue
        val = df[col].iloc[0]
        if pd.isna(val):
            continue
        try:
            num = float(val)
        except Exception:
            continue
        if num == 1:
            yes += 1
        elif num == 0:
            no += 1

    answered = yes + no
    if answered < 3:
        return p

    # All/near-all symptoms denied → meaningful dampening toward Negative/Borderline
    if yes == 0 and no >= 4:
        factor = 0.78
    elif yes == 0 and no >= 3:
        factor = 0.85
    elif yes == 1 and no >= 3:
        factor = 0.92
    elif yes <= 1 and no >= 4:
        factor = 0.94
    else:
        return p

    return float(max(1.0, min(99.0, p * factor)))
def apply_threshold_aware_smoothing(probability_percentage, smoothing_factor=1.0):
    """
    Threshold-aware smoothing using the Regular User thresholds:
      0-54    -> Negative
      55-74   -> Borderline
      75-100  -> Positive

    It pulls the predicted percentage toward the center of the band it falls into,
    making results more stable around the thresholds.

    smoothing_factor meaning:
      1.0 -> no smoothing
      lower -> stronger smoothing (more pull toward the band center)
    """
    try:
        p = float(probability_percentage)
    except Exception:
        return probability_percentage

    try:
        sf = float(smoothing_factor)
    except Exception:
        sf = 1.0

    sf = max(0.50, min(1.0, sf))
    if sf >= 0.999:
        return p

    # Band centers chosen from thresholds
    # Negative center: (0+54)/2 = 27
    # Borderline center: (55+74)/2 = 64.5
    # Positive center: (75+100)/2 = 87.5
    if p <= 54:
        center = 27.0
    elif p <= 74:
        center = 64.5
    else:
        center = 87.5

    smoothed = center + sf * (p - center)
    return float(max(1, min(99, smoothed)))

def convert_to_percentage(prediction, smoothing_factor=1.0):
    """
    Convert model output to percentage with full responsive range.
    Maps model probability (0-1) to clinical risk percentage (0-100) with minimal compression.
    """
    # Handle numpy arrays
    if isinstance(prediction, np.ndarray):
        prediction = float(prediction[0]) if prediction.shape[0] > 0 else float(prediction.item())
    else:
        prediction = float(prediction)
    
    # Ensure prediction is in valid range
    prediction = max(0, min(1, prediction))

    # Optional temperature-style smoothing (lower factor => stronger smoothing).
    # We implement this as a simple linear compression around 0.5:
    #   p' = 0.5 + smoothing_factor * (p - 0.5)
    # smoothing_factor=1.0 => no change
    # smoothing_factor=0.80 => stronger smoothing (less extreme)
    try:
        sf = float(smoothing_factor)
    except Exception:
        sf = 1.0
    sf = max(0.50, min(1.0, sf))
    prediction = 0.5 + sf * (prediction - 0.5)
    prediction = max(0, min(1, prediction))
    
    # Simple linear scaling with slight adjustments for extreme values
    # This allows full range from near 0% to near 100%
    if prediction < 0.1:
        # Very low predictions: scale to 0-10%
        percentage = prediction * 100
    elif prediction > 0.9:
        # Very high predictions: scale to 90-100%
        percentage = 90 + (prediction - 0.9) * 100
    else:
        # Middle range: direct linear mapping
        percentage = prediction * 100
    
    # Allow full 0-100 range
    return max(1, min(99, percentage))

def classify_result(percentage):
    """
    Classify result with three-way thresholds (aligned with Regular User UI):
      0-54%   -> Negative
      55-74%  -> Borderline
      75-100% -> Positive
    """
    p = float(percentage)
    if p <= 54:
        classification = 'Negative'
        description = 'Clinical data does not support PCOS diagnosis'
    elif p <= 74:
        classification = 'Borderline'
        description = 'Clinical data shows intermediate PCOS risk'
    else:
        classification = 'Positive'
        description = 'Clinical data supports PCOS diagnosis'

    return {
        'classification': classification,
        'description': description
    }

def predict(clinical_data, model_path, smoothing_factor=1.0):
    """Main prediction function"""
    try:
        # Load model
        model = load_xgboost_model(model_path)
        
        # Get model's expected features BEFORE preparing data
        expected_features = None
        if hasattr(model, 'get_booster'):
            try:
                booster = model.get_booster()
                if hasattr(booster, 'feature_names') and booster.feature_names:
                    expected_features = booster.feature_names
            except:
                pass
        
        # Prepare data (pass model so it can extract feature names)
        df = prepare_clinical_data(clinical_data, model)
        
        # Calculate data quality metrics
        total_features = len(df.columns)
        missing_count = int(df.isna().sum().sum())
        missing_percentage = (missing_count / total_features) * 100 if total_features > 0 else 0
        
        # Get fields with actual non-NaN values
        fields_with_values = []
        fields_with_zeros = []
        critical_missing_fields = []  # Track CRITICAL fields that are missing
        
        # Define which fields are critical for diagnosis (should never be NaN)
        critical_fields = {
            ' Age (yrs)', 'Weight (Kg)', 'Height(Cm) ', 'BMI',
            'Pulse rate(bpm) ', 'Cycle length(days)',
            'FSH(mIU/mL)', 'LH(mIU/mL)', 'AMH(ng/mL)',
        }
        
        # Allow predictions even with limited data - XGBoost can handle missing values
        # (commented out strict validation to enable partial data predictions)
        
        for col in df.columns:
            val = df[col].iloc[0]
            if pd.notna(val):
                if val == 0:
                    fields_with_zeros.append(col)
                else:
                    fields_with_values.append(col)
            else:
                # This field is missing/NaN
                if col in critical_fields:
                    critical_missing_fields.append(col)
        
        # Calculate missing percentage for CRITICAL fields only
        if critical_fields:
            critical_missing_count = len(critical_missing_fields)
            critical_total = len(critical_fields)
            critical_missing_percentage = (critical_missing_count / critical_total) * 100
        else:
            critical_missing_count = 0
            critical_missing_percentage = 0
        
        # Extract ultrasound parameters for detailed logging
        ultrasound_fields = {
            'Follicle No. (L)', 'Follicle No. (R)',
            'Avg. F size (L) (mm)', 'Avg. F size (R) (mm)',
            'Endometrium (mm)'
        }
        
        ultrasound_values = {}
        ultrasound_present_count = 0
        ultrasound_missing_fields = []
        
        for col in df.columns:
            if col in ultrasound_fields:
                val = df[col].iloc[0]
                ultrasound_values[col] = float(val) if pd.notna(val) else None
                if pd.notna(val):
                    ultrasound_present_count += 1
                else:
                    ultrasound_missing_fields.append(col)
        
        # Debug info (stored for response, not printed)
        debug_info = {
            'total_features': total_features,
            'missing_count': missing_count,
            'missing_percentage': round(missing_percentage, 1),
            'critical_missing_count': critical_missing_count,
            'critical_missing_percentage': round(critical_missing_percentage, 1),
            'critical_missing_fields': critical_missing_fields,
            'features_with_values': len(fields_with_values),
            'fields_with_non_zero_values': fields_with_values[:10],
            'fields_with_zero_values': fields_with_zeros[:10],
            'ultrasound_fields_present': ultrasound_present_count,
            'ultrasound_values': ultrasound_values,
            'ultrasound_missing_fields': ultrasound_missing_fields,
            'matched_ultrasound_features': matched_ultrasound if 'matched_ultrasound' in locals() else [],
            'unmatched_ultrasound_features': unmatched_ultrasound if 'unmatched_ultrasound' in locals() else [],
            'input_data_keys': list(clinical_data.keys()),
            'dataframe_columns': list(df.columns),
            'dataframe_head': {col: str(df[col].iloc[0]) for col in df.columns[:5]},
            'all_feature_values': {col: (float(df[col].iloc[0]) if pd.notna(df[col].iloc[0]) else None) for col in df.columns},
        }
        
        # Handle missing values - XGBoost can handle NaN
        df = df.astype(np.float32)
        
        # CREATE MASK OF MISSING VALUES (for SHAP explanation)
        missing_mask = df.isna().iloc[0].values.tolist()
        
        # Count missing values
        missing_count_report = int(df.isna().sum().sum())
        
        # KEEP NaN values as-is (XGBoost handles them during prediction)
        # This allows the model to distinguish between "no data" and "data is 0"
        
        # Add info to debug output
        debug_info['missing_values_handled'] = True
        debug_info['missing_count_final'] = missing_count_report
        debug_info['expected_model_features'] = expected_features
        
        # Try to make prediction
        try:
            # Use predict_proba to get probability scores instead of just class labels
            if hasattr(model, 'predict_proba'):
                proba = model.predict_proba(df)
                # proba returns [[prob_class_0, prob_class_1]], we want prob_class_1 (PCOS positive)
                raw_prediction = proba[0][1]
                debug_info['predict_proba'] = proba[0].tolist()
            else:
                # Fallback to predict if predict_proba not available
                raw_prediction = model.predict(df)[0]
                
            debug_info['raw_model_output'] = float(raw_prediction)
                
        except Exception as e:
            error_msg = str(e)
            # Check if it's a feature names mismatch error
            if "feature_names" in error_msg.lower() or "mismatch" in error_msg.lower():
                # Get model's expected features
                try:
                    if hasattr(model, 'get_booster'):
                        booster = model.get_booster()
                        if hasattr(booster, 'feature_names'):
                            expected = booster.feature_names
                            actual = list(df.columns)
                            return {
                                'success': False,
                                'error': f'Feature mismatch. Expected: {expected}, Got: {actual}'
                            }
                except:
                    pass
                return {
                    'success': False,
                    'error': f'Model prediction failed: {error_msg}'
                }
            raise
        
        # CALIBRATE for class imbalance before converting to percentage
        # This adjusts the raw model probability based on training data prevalence
        calibrated_prob = calibrate_for_class_imbalance(raw_prediction)
        debug_info['calibrated_probability'] = float(calibrated_prob)
        
        # Convert calibrated probability to percentage
        probability_percentage = convert_to_percentage(calibrated_prob, smoothing_factor=smoothing_factor)
        debug_info['converted_percentage'] = round(probability_percentage, 2)
        debug_info['smoothing_factor'] = float(smoothing_factor)
        
        # Symptom balance:
        # - Boost slightly only when hormones are mostly missing AND ≥2 symptoms are Yes
        # - Dampen when symptoms are mostly/explicitly No (reduces false Positive lean)
        hormonal_fields = {'FSH(mIU/mL)', 'LH(mIU/mL)', 'AMH(ng/mL)', 'TSH (mIU/L)', 'PRL(ng/mL)', 'PRG(ng/mL)', 'Vit D3 (ng/mL)'}
        symptom_fields = {'Weight gain(Y/N)', 'hair growth(Y/N)', 'Skin darkening (Y/N)', 'Hair loss(Y/N)', 'Pimples(Y/N)'}
        
        hormonal_present = [col for col in df.columns if col in hormonal_fields and pd.notna(df[col].iloc[0])]
        hormonal_missing_count = len(hormonal_fields) - len(hormonal_present)
        
        positive_symptoms = 0
        negative_symptoms = 0
        for col in df.columns:
            if col in symptom_fields:
                val = df[col].iloc[0]
                if pd.notna(val) and val == 1:
                    positive_symptoms += 1
                elif pd.notna(val) and val == 0:
                    negative_symptoms += 1
        
        symptom_boost = 0
        if hormonal_missing_count >= 5 and positive_symptoms >= 2:
            symptom_boost = positive_symptoms * 0.5  # smaller than before
            probability_percentage = probability_percentage + symptom_boost
            debug_info['symptom_boost_applied'] = True
            debug_info['symptom_boost_percentage'] = round(symptom_boost, 2)
        else:
            debug_info['symptom_boost_applied'] = False

        debug_info['positive_symptoms'] = positive_symptoms
        debug_info['negative_symptoms'] = negative_symptoms
        debug_info['hormonal_tests_available'] = len(hormonal_present)
        
        # Get SHAP explanation (pass missing_mask and raw_prediction for proper calibration)
        shap_explanation = get_shap_explanation(model, df, raw_prediction, missing_mask)
        
        # Extract priority factors: clinical symptoms, ultrasound findings, and hormones
        clinical_symptoms = {
            'Weight gain(Y/N)', 'hair growth(Y/N)', 'Skin darkening (Y/N)', 
            'Hair loss(Y/N)', 'Pimples(Y/N)'
        }
        ultrasound_findings = {
            'Follicle No. (L)', 'Follicle No. (R)',
            'Avg. F size (L) (mm)', 'Avg. F size (R) (mm)',
            'Endometrium (mm)'
        }
        hormonal_markers = {
            'FSH(mIU/mL)', 'LH(mIU/mL)', 'AMH(ng/mL)', 'TSH (mIU/L)',
            'PRL(ng/mL)', 'PRG(ng/mL)', 'Vit D3 (ng/mL)', 'FSH/LH'
        }
        
        priority_contribution_summary = {
            'clinical_symptoms': [],
            'ultrasound_findings': [],
            'hormonal_markers': [],
            'clinical_symptoms_positive_count': 0,
            'clinical_symptoms_negative_count': negative_symptoms,
            'ultrasound_findings_present_count': 0,
            'hormonal_markers_present_count': 0
        }
        
        if shap_explanation and shap_explanation.get('success'):
            contributions = shap_explanation.get('top_contributions', [])
            
            for contrib in contributions:
                feature = contrib.get('feature', '')
                
                if feature in clinical_symptoms:
                    if contrib.get('value') == 1:  # Symptom is present
                        priority_contribution_summary['clinical_symptoms'].append({
                            'feature': feature,
                            'impact': contrib.get('impact'),
                            'influence_score': round(contrib.get('influence_score', 0), 4)
                        })
                        priority_contribution_summary['clinical_symptoms_positive_count'] += 1
                
                elif feature in ultrasound_findings:
                    if contrib.get('value') is not None:  # Has ultrasound data
                        priority_contribution_summary['ultrasound_findings'].append({
                            'feature': feature,
                            'value': round(contrib.get('value', 0), 2),
                            'impact': contrib.get('impact'),
                            'influence_score': round(contrib.get('influence_score', 0), 4)
                        })
                        priority_contribution_summary['ultrasound_findings_present_count'] += 1
                
                elif feature in hormonal_markers:
                    if contrib.get('value') is not None:  # Has hormonal data
                        priority_contribution_summary['hormonal_markers'].append({
                            'feature': feature,
                            'value': round(contrib.get('value', 0), 2),
                            'impact': contrib.get('impact'),
                            'influence_score': round(contrib.get('influence_score', 0), 4)
                        })
                        priority_contribution_summary['hormonal_markers_present_count'] += 1
        
        # Apply SHAP-aware calibration: protective-only (no risk inflation)
        probability_percentage = apply_shap_aware_adjustment(probability_percentage, shap_explanation)
        debug_info['shap_adjusted_percentage'] = round(probability_percentage, 2)

        # Explicit No symptoms → dampen Positive lean
        before_symptom_adj = probability_percentage
        probability_percentage = apply_symptom_absence_adjustment(probability_percentage, df)
        debug_info['symptom_absence_adjusted_percentage'] = round(probability_percentage, 2)
        debug_info['symptom_absence_delta'] = round(probability_percentage - before_symptom_adj, 2)
        # Threshold-aware smoothing (Regular User request). Applied only when smoothing_factor < 1.
        try:
            sf = float(smoothing_factor)
        except Exception:
            sf = 1.0
        if sf < 0.999:
            probability_percentage = apply_threshold_aware_smoothing(probability_percentage, smoothing_factor=sf)
            debug_info['threshold_smoothed_percentage'] = round(probability_percentage, 2)
        
        # Get classification (percentage-based only)
        classification_result = classify_result(probability_percentage)
        
        result = {
            'success': True,
            'probability_percentage': round(probability_percentage, 2),
            'classification': classification_result['classification'],
            'description': classification_result['description'],
            'model_threshold_percentage': 75.0,  # Requires 75%+ certainty to diagnose as positive
            'confidence': (
                'High' if probability_percentage < 25 or probability_percentage > 82 else
                'Moderate' if probability_percentage < 38 or probability_percentage > 75 else
                'Low'
            ),
            'missing_values': missing_count,
            'missing_percentage': round(missing_percentage, 1),
            'priority_factors': priority_contribution_summary,  # Clinical symptoms & ultrasound findings
            'shap_explanation': shap_explanation,  # Always include SHAP explanation (success or error)
            'smoothing_factor': float(sf)
        }
        
        return result
    except Exception as e:
        return {
            'success': False,
            'error': str(e)
        }

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({
            'success': False,
            'error': 'No clinical data provided'
        }))
        sys.exit(1)
    
    try:
        # Read JSON clinical data from file (passed as argument)
        file_path = sys.argv[1]
        with open(file_path, 'r') as f:
            clinical_data = json.load(f)
        
        # Model path - use v5 model
        model_dir = Path(__file__).parent / 'XGBoost Model'
        model_path = str(model_dir / 'xgboost_pcos_model_v5.pkl')
        
        # Optional smoothing factor (second argument)
        smoothing_factor = 1.0
        if len(sys.argv) > 2:
            try:
                smoothing_factor = float(sys.argv[2])
            except Exception:
                smoothing_factor = 1.0

        # Run prediction
        result = predict(clinical_data, model_path, smoothing_factor=smoothing_factor)
        # Convert all numpy types to Python native types for JSON serialization
        result = convert_to_python_types(result)
        
        # Use custom JSON encoder that handles any remaining serialization issues
        try:
            output = json.dumps(result)
        except TypeError as json_error:
            # Fallback: try to identify what can't be serialized
            print(json.dumps({
                'success': False,
                'error': f'JSON serialization error: {str(json_error)}. This may indicate a data type issue in the prediction result.'
            }))
            sys.exit(1)
        
        print(output)
        
    except json.JSONDecodeError as e:
        print(json.dumps({
            'success': False,
            'error': f'Invalid JSON input: {str(e)}'
        }))
        sys.exit(1)
    except Exception as e: 
        print(json.dumps({
            'success': False,
            'error': str(e)
        }))
        sys.exit(1)
