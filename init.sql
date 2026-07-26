CREATE TABLE IF NOT EXISTS files (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INT NOT NULL,
  mime TEXT,
  download_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS edges (
  id INT PRIMARY KEY,
  edge_name TEXT NOT NULL,
  status TEXT DEFAULT 'healthy',
  last_seen TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS request_logs (
  id SERIAL PRIMARY KEY,
  file_id INT NOT NULL,
  edge_id INT NOT NULL,
  hit BOOLEAN NOT NULL,
  latency_ms INT NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);
