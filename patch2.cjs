const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

code = code.replace(
  "import { Loader2, BrainCircuit, FileText, BarChart, ChevronDown, ChevronRight, Activity, Clock, CheckCircle2, AlertCircle, Settings, X, Database, Bot } from 'lucide-react';",
  "import { Loader2, BrainCircuit, FileText, BarChart, ChevronDown, ChevronRight, Activity, Clock, CheckCircle2, AlertCircle, Settings, X, Database, Bot } from 'lucide-react';\nimport { ComponentRegistry } from './components/generative/ComponentRegistry';"
);

fs.writeFileSync('src/App.tsx', code);
