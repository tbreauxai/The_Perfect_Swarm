const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

const target = `  const [settings, setSettings] = useState({`;
const newTarget = `  const [envStatus, setEnvStatus] = useState<any>({});
  
  useEffect(() => {
    fetch('/api/config/status').then(res => res.json()).then(data => setEnvStatus(data)).catch(console.error);
  }, []);

  const [settings, setSettings] = useState({`;

code = code.replace(target, newTarget);
fs.writeFileSync('src/App.tsx', code);
