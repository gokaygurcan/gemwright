FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive GEMWRIGHT_EMULATOR=runuo
RUN apt-get update && apt-get install -y --no-install-recommends mono-devel libgdiplus zlib1g tzdata ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/server
COPY server/ ./
RUN mcs -optimize+ -unsafe -t:exe -out:RunUO.exe -nowarn:219,414 -d:NEWTIMERS -d:NEWPARENT -d:MONO -reference:System.Drawing -recurse:Server/*.cs
COPY seed/ /opt/seed/
COPY start.sh run-server.sh /opt/gemwright/
RUN chmod +x /opt/gemwright/*.sh
WORKDIR /app
EXPOSE 2593
ENTRYPOINT ["/opt/gemwright/start.sh"]
