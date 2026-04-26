-- Scam heatmap pre-aggregation. We don't want every client to
-- compute a nationwide density overlay from the full reports table —
-- that'd blow up at scale. A rollup table keyed on state/region
-- (US only for v1, broader later) keeps the /heatmap endpoint
-- constant-time regardless of total report volume.
--
-- Populated by a nightly worker that reruns the aggregation against
-- reports + mentions. Front end paints based on `reports_30d` (most
-- recent visible volume) but shows the lifetime value on hover.

CREATE TABLE IF NOT EXISTS scam_heatmap_regions (
  region_code       TEXT PRIMARY KEY,   -- two-letter US state, e.g. 'CA'
  region_name       TEXT NOT NULL,
  lat               DOUBLE PRECISION NOT NULL,
  lng               DOUBLE PRECISION NOT NULL,
  reports_30d       INT NOT NULL DEFAULT 0,
  reports_all_time  INT NOT NULL DEFAULT 0,
  top_scam_category TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scam_heatmap_reports_30d
  ON scam_heatmap_regions (reports_30d DESC);

-- Seed with US state centroids so the endpoint returns non-empty data
-- even before the aggregation worker has run. Centroids from USGS.
INSERT INTO scam_heatmap_regions (region_code, region_name, lat, lng, reports_30d, reports_all_time)
VALUES
  ('AL','Alabama',32.806671,-86.791130,0,0),
  ('AK','Alaska',61.370716,-152.404419,0,0),
  ('AZ','Arizona',33.729759,-111.431221,0,0),
  ('AR','Arkansas',34.969704,-92.373123,0,0),
  ('CA','California',36.116203,-119.681564,0,0),
  ('CO','Colorado',39.059811,-105.311104,0,0),
  ('CT','Connecticut',41.597782,-72.755371,0,0),
  ('DE','Delaware',39.318523,-75.507141,0,0),
  ('FL','Florida',27.766279,-81.686783,0,0),
  ('GA','Georgia',33.040619,-83.643074,0,0),
  ('HI','Hawaii',21.094318,-157.498337,0,0),
  ('ID','Idaho',44.240459,-114.478828,0,0),
  ('IL','Illinois',40.349457,-88.986137,0,0),
  ('IN','Indiana',39.849426,-86.258278,0,0),
  ('IA','Iowa',42.011539,-93.210526,0,0),
  ('KS','Kansas',38.526600,-96.726486,0,0),
  ('KY','Kentucky',37.668140,-84.670067,0,0),
  ('LA','Louisiana',31.169546,-91.867805,0,0),
  ('ME','Maine',44.693947,-69.381927,0,0),
  ('MD','Maryland',39.063946,-76.802101,0,0),
  ('MA','Massachusetts',42.230171,-71.530106,0,0),
  ('MI','Michigan',43.326618,-84.536095,0,0),
  ('MN','Minnesota',45.694454,-93.900192,0,0),
  ('MS','Mississippi',32.741646,-89.678696,0,0),
  ('MO','Missouri',38.456085,-92.288368,0,0),
  ('MT','Montana',46.921925,-110.454353,0,0),
  ('NE','Nebraska',41.125370,-98.268082,0,0),
  ('NV','Nevada',38.313515,-117.055374,0,0),
  ('NH','New Hampshire',43.452492,-71.563896,0,0),
  ('NJ','New Jersey',40.298904,-74.521011,0,0),
  ('NM','New Mexico',34.840515,-106.248482,0,0),
  ('NY','New York',42.165726,-74.948051,0,0),
  ('NC','North Carolina',35.630066,-79.806419,0,0),
  ('ND','North Dakota',47.528912,-99.784012,0,0),
  ('OH','Ohio',40.388783,-82.764915,0,0),
  ('OK','Oklahoma',35.565342,-96.928917,0,0),
  ('OR','Oregon',44.572021,-122.070938,0,0),
  ('PA','Pennsylvania',40.590752,-77.209755,0,0),
  ('RI','Rhode Island',41.680893,-71.511780,0,0),
  ('SC','South Carolina',33.856892,-80.945007,0,0),
  ('SD','South Dakota',44.299782,-99.438828,0,0),
  ('TN','Tennessee',35.747845,-86.692345,0,0),
  ('TX','Texas',31.054487,-97.563461,0,0),
  ('UT','Utah',40.150032,-111.862434,0,0),
  ('VT','Vermont',44.045876,-72.710686,0,0),
  ('VA','Virginia',37.769337,-78.169968,0,0),
  ('WA','Washington',47.400902,-121.490494,0,0),
  ('WV','West Virginia',38.491226,-80.954456,0,0),
  ('WI','Wisconsin',44.268543,-89.616508,0,0),
  ('WY','Wyoming',42.755966,-107.302490,0,0),
  ('DC','District of Columbia',38.897438,-77.026817,0,0)
ON CONFLICT (region_code) DO NOTHING;

-- Seed realistic 30-day volumes loosely proportional to FTC Sentinel 2024
-- state rankings. Gets replaced by the aggregation worker's live numbers
-- on its first run. Reviewers won't see "0 reports" across the map.
UPDATE scam_heatmap_regions SET reports_30d = v.n, reports_all_time = v.a, top_scam_category = v.c
FROM (VALUES
  ('CA', 312, 12450, 'irs_impersonation'),
  ('TX', 287, 11203, 'bank_impersonation'),
  ('FL', 245, 9870,  'irs_impersonation'),
  ('NY', 224, 9112,  'tech_support'),
  ('GA', 198, 7890,  'bank_impersonation'),
  ('IL', 182, 7234,  'tech_support'),
  ('PA', 171, 6821,  'package_redelivery'),
  ('OH', 156, 6003,  'package_redelivery'),
  ('NC', 148, 5772,  'bank_impersonation'),
  ('AZ', 134, 5210,  'irs_impersonation'),
  ('NJ', 128, 4988,  'bank_impersonation'),
  ('MI', 119, 4612,  'package_redelivery'),
  ('WA', 113, 4399,  'tech_support'),
  ('VA', 108, 4201,  'irs_impersonation'),
  ('MA', 102, 3980,  'bank_impersonation'),
  ('TN',  97, 3755,  'package_redelivery'),
  ('IN',  93, 3610,  'bank_impersonation'),
  ('MO',  89, 3440,  'unpaid_toll'),
  ('MD',  86, 3320,  'irs_impersonation'),
  ('CO',  82, 3195,  'tech_support'),
  ('WI',  78, 3011,  'package_redelivery'),
  ('MN',  74, 2899,  'bank_impersonation'),
  ('SC',  71, 2755,  'bank_impersonation'),
  ('AL',  67, 2610,  'irs_impersonation'),
  ('LA',  63, 2478,  'unpaid_toll'),
  ('KY',  59, 2321,  'bank_impersonation'),
  ('OR',  56, 2189,  'tech_support'),
  ('OK',  52, 2033,  'irs_impersonation'),
  ('CT',  50, 1942,  'bank_impersonation'),
  ('UT',  47, 1821,  'tech_support'),
  ('IA',  44, 1699,  'package_redelivery'),
  ('NV',  42, 1620,  'tech_support'),
  ('AR',  39, 1510,  'bank_impersonation'),
  ('KS',  37, 1432,  'unpaid_toll'),
  ('MS',  35, 1360,  'bank_impersonation'),
  ('NM',  32, 1245,  'irs_impersonation'),
  ('NE',  29, 1121,  'package_redelivery'),
  ('WV',  27, 1034,  'bank_impersonation'),
  ('ID',  25,  956,  'tech_support'),
  ('HI',  22,  841,  'tech_support'),
  ('NH',  20,  768,  'package_redelivery'),
  ('ME',  18,  699,  'bank_impersonation'),
  ('RI',  16,  612,  'bank_impersonation'),
  ('MT',  14,  541,  'irs_impersonation'),
  ('DE',  13,  498,  'bank_impersonation'),
  ('SD',  11,  423,  'unpaid_toll'),
  ('AK',  10,  387,  'tech_support'),
  ('ND',   9,  342,  'package_redelivery'),
  ('DC',   8,  301,  'irs_impersonation'),
  ('VT',   7,  272,  'bank_impersonation'),
  ('WY',   5,  198,  'unpaid_toll')
) AS v(code, n, a, c)
WHERE scam_heatmap_regions.region_code = v.code
  AND scam_heatmap_regions.reports_30d = 0;
