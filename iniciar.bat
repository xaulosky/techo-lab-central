@echo off
cd /d "%~dp0.."
echo Servidor en http://localhost:8000/interfaz/  (cierra esta ventana para detenerlo)
start "" http://localhost:8000/interfaz/
python -m http.server 8000 --bind 127.0.0.1
