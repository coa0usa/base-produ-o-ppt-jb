@echo off
echo ========================================
echo   SERVIDOR LOCAL - SISTEMA INTEGRADO
echo ========================================
echo.
echo Iniciando servidor em http://localhost:8080
echo.
echo Abrindo no navegador automaticamente...
start http://localhost:8080/Banco_dados_PPT.html
echo.
echo IMPORTANTE: Mantenha esta janela aberta!
echo Pressione CTRL+C para encerrar o servidor.
echo.
python -m http.server 8080
echo.
echo Se Python nao funcionar, tente:
echo python3 -m http.server 8080
pause
