insert into decision_rules_config (company_id, rule_key, threshold_value, description) values
  (null, 'duplicate_review_threshold', 70, 'Duplicate score (0-100) at or above this triggers REVIEW / Hold - Duplicate Suspected'),
  (null, 'budget_review_threshold_pct', 85, 'Projected budget utilization % at or above this triggers REVIEW'),
  (null, 'budget_defer_threshold_pct', 95, 'Projected budget utilization % at or above this triggers DEFER'),
  (null, 'anomaly_review_threshold', 60, 'Anomaly score (0-100) at or above this triggers REVIEW'),
  (null, 'vendor_amount_multiplier_threshold', 3, 'Invoice amount vs vendor historical average multiplier that counts as anomalous'),
  (null, 'bank_change_lookback_days', 30, 'A vendor bank-account change within this many days of an invoice is treated as high risk');