FROM mcr.microsoft.com/dotnet/sdk:10.0-noble AS build
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
WORKDIR /source
COPY server/ ./
RUN dotnet publish Projects/Application/Application.csproj -c Release --self-contained false --nologo

FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble
ENV GEMWRIGHT_EMULATOR=modernuo
RUN apt-get update && apt-get install -y --no-install-recommends libdeflate0 libargon2-1 tzdata && rm -rf /var/lib/apt/lists/*
COPY --from=build /source/Distribution/ /opt/server/
COPY seed/ /opt/seed/
COPY start.sh run-server.sh /opt/gemwright/
RUN chmod +x /opt/gemwright/*.sh
WORKDIR /app
EXPOSE 2593
ENTRYPOINT ["/opt/gemwright/start.sh"]
