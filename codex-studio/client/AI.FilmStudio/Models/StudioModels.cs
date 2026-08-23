namespace AI.FilmStudio.Models;

public sealed record Shot(string Number, string Title, string Description, string Duration, string Status, string Color);
public sealed record Episode(string Title, string Duration, bool IsActive = false);
public sealed record Finding(string Shot, string Message, string Action);
public sealed record Workspace(string Key, string Title);

