FROM mcr.microsoft.com/dotnet/sdk:10.0-noble
ENV DEBIAN_FRONTEND=noninteractive DOTNET_CLI_TELEMETRY_OPTOUT=1
RUN apt-get update && \
    apt-get install -y --no-install-recommends mono-devel libgdiplus zlib1g-dev tzdata && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /opt/servuo
COPY server/ ./
RUN dotnet build ServUO.sln -c Release --nologo -v quiet
COPY seed/ /opt/seed/
COPY start.sh run-server.sh /opt/gemwright/
RUN chmod +x /opt/gemwright/*.sh
WORKDIR /app
EXPOSE 2593
ENTRYPOINT ["/opt/gemwright/start.sh"]
